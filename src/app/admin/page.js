"use client";
import { useState, useRef, useEffect } from 'react';
import { io } from "socket.io-client";

export default function Admin() {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const peerConnection = useRef(null);
    const socket = useRef(null);
    const localStream = useRef(null);
    const pendingIceCandidates = useRef([]);

    const [callState, setCallState] = useState("idle"); // idle, incoming, active
    const [pendingCalls, setPendingCalls] = useState({});
    const [currentClientId, setCurrentClientId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [message, setMessage] = useState("");
    const [repId, setRepId] = useState("");
    const [roomId, setRoomId] = useState(null);
    const [debug, setDebug] = useState([]);
    const [connectionStatus, setConnectionStatus] = useState("Not Connected");

    // State for microphone and video toggles
    const [isMicMuted, setIsMicMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);

    const SERVER_URL = "http://3.87.251.192:3001";

    // Add debug log function
    const logDebug = (message, data = null) => {
        const timestamp = new Date().toISOString().substr(11, 8);
        const logMessage = `${timestamp} - ${message}${data ? ': ' + JSON.stringify(data) : ''}`;
        console.log(logMessage);
        setDebug(prev => [logMessage, ...prev].slice(0, 20)); // Keep last 20 logs
    };

    // Function to process pending ICE candidates
    const processPendingIceCandidates = () => {
        if (peerConnection.current && peerConnection.current.remoteDescription) {
            logDebug(`Processing ${pendingIceCandidates.current.length} pending ICE candidates`);

            pendingIceCandidates.current.forEach(candidate => {
                peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate))
                    .then(() => logDebug("Pending ICE candidate added successfully"))
                    .catch(err => logDebug("Error adding pending ICE candidate", err));
            });

            pendingIceCandidates.current = [];
        } else {
            logDebug("Cannot process pending ICE candidates - remote description not set yet");
        }
    };

    useEffect(() => {
        // Initialize Socket.IO connection
        socket.current = io(SERVER_URL, {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        socket.current.on("connect", () => {
            logDebug("Socket connected");
            setConnectionStatus("Connected");
        });

        socket.current.on("disconnect", () => {
            logDebug("Socket disconnected");
            setConnectionStatus("Disconnected");
        });

        socket.current.on("connect_error", (error) => {
            logDebug("Socket connection error", error);
            setConnectionStatus("Error: Failed to connect");
        });

        // Get pending calls
        const fetchPendingCalls = async () => {
            try {
                logDebug("Fetching pending calls");
                const response = await fetch(`${SERVER_URL}/get_pending_calls`);
                const data = await response.json();
                logDebug("Pending calls received", data);
                setPendingCalls(data.pending_calls || {});
            } catch (error) {
                logDebug("Error fetching pending calls", error);
            }
        };

        fetchPendingCalls();

        // Start local stream
        const startLocalStream = async () => {
            try {
                logDebug("Starting local media stream");
                localStream.current = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true
                });

                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = localStream.current;
                    logDebug("Local video stream attached to video element");
                }
            } catch (error) {
                logDebug("Error accessing media devices", error);
                alert("Error accessing camera or microphone: " + error.message);
            }
        };

        startLocalStream();

        // Socket event listeners
        socket.current.on("new_call", (data) => {
            logDebug("New call received", data);
            setPendingCalls(prev => ({
                ...prev,
                [data.client_id]: "waiting"
            }));
        });

        socket.current.on("call_ended", (data) => {
            logDebug("Call ended received", data);
            if (data.client_id === currentClientId) {
                endCall(false); // Don't emit end_call event
            }

            setPendingCalls(prev => {
                const newPendingCalls = { ...prev };
                delete newPendingCalls[data.client_id];
                return newPendingCalls;
            });
        });

        socket.current.on("receive_message", (data) => {
            logDebug("Message received", data);
            setMessages(prev => [...prev, {
                sender: "Client",
                text: data.message
            }]);
        });

        socket.current.on("answer", (data) => {
            logDebug("Remote answer received", data);
            if (peerConnection.current) {
                peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.answer))
                    .then(() => {
                        logDebug("Remote description set successfully");
                        // Process any pending ICE candidates
                        processPendingIceCandidates();
                    })
                    .catch(err => logDebug("Error setting remote description", err));
            } else {
                logDebug("Error: Peer connection not initialized when answer received");
            }
        });

        socket.current.on("ice_candidate", (data) => {
            logDebug("ICE candidate received", data);
            if (peerConnection.current) {
                // Only try to add the candidate if we have a remote description
                if (peerConnection.current.remoteDescription) {
                    peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate))
                        .then(() => logDebug("ICE candidate added successfully"))
                        .catch(err => logDebug("Error adding ICE candidate", err));
                } else {
                    // Otherwise, queue it up for later
                    logDebug("Remote description not set yet, queuing ICE candidate");
                    pendingIceCandidates.current.push(data.candidate);
                }
            } else {
                logDebug("Error: Peer connection not initialized when ICE candidate received");
            }
        });

        // Check for pending calls periodically
        const interval = setInterval(fetchPendingCalls, 5000);

        return () => {
            logDebug("Cleaning up resources");
            clearInterval(interval);
            endLocalStream();
            if (peerConnection.current) {
                peerConnection.current.close();
            }
            if (socket.current) {
                socket.current.disconnect();
            }
        };
    }, []);

    const endLocalStream = () => {
        if (localStream.current) {
            logDebug("Ending local stream");
            localStream.current.getTracks().forEach(track => track.stop());
            localStream.current = null;
        }
    };

    const createPeerConnection = async (clientId) => {
        try {
            logDebug("Creating new peer connection");
            // Get TURN server credentials
            const response = await fetch(`${SERVER_URL}/get-turn-credentials`, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });

            const data = await response.json();
            logDebug("TURN credentials received", data);

            // Create new RTCPeerConnection with TURN servers
            const configuration = {
                iceServers: data.iceServers || [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ],
                iceCandidatePoolSize: 10,
            };

            logDebug("RTCPeerConnection configuration", configuration);
            peerConnection.current = new RTCPeerConnection(configuration);

            // Add local stream to peer connection
            if (localStream.current) {
                logDebug("Adding local tracks to peer connection");
                localStream.current.getTracks().forEach(track => {
                    peerConnection.current.addTrack(track, localStream.current);
                });
            } else {
                logDebug("Error: Local stream not available when creating peer connection");
                throw new Error("Local stream not available");
            }

            // Set up event handlers for the peer connection
            peerConnection.current.ontrack = (event) => {
                logDebug("Remote track received", {
                    kind: event.track.kind,
                    streamId: event.streams[0]?.id
                });

                if (remoteVideoRef.current && event.streams[0]) {
                    remoteVideoRef.current.srcObject = event.streams[0];
                    logDebug("Remote stream attached to video element");
                } else {
                    logDebug("Error attaching remote stream to video element");
                }
            };

            peerConnection.current.onicecandidate = (event) => {
                if (event.candidate) {
                    logDebug("Local ICE candidate generated", {
                        candidate: event.candidate.candidate.substring(0, 50) + "..."
                    });

                    socket.current.emit("ice_candidate", {
                        candidate: event.candidate,
                        room: roomId
                    });
                }
            };

            peerConnection.current.oniceconnectionstatechange = () => {
                const state = peerConnection.current.iceConnectionState;
                logDebug("ICE connection state changed", { state });

                if (state === 'disconnected' || state === 'failed') {
                    logDebug("ICE connection failed or disconnected, attempting recovery");
                    // We'll try to recover with a new offer after a short delay
                    setTimeout(async () => {
                        if (callState === "active") {
                            try {
                                logDebug("Creating recovery offer");
                                const offer = await peerConnection.current.createOffer({
                                    iceRestart: true,
                                    offerToReceiveAudio: true,
                                    offerToReceiveVideo: true
                                });

                                await peerConnection.current.setLocalDescription(offer);

                                socket.current.emit("offer", {
                                    offer,
                                    room: roomId
                                });

                                logDebug("Recovery offer sent");
                            } catch (error) {
                                logDebug("Error creating recovery offer", error);
                            }
                        }
                    }, 2000);
                }
            };

            peerConnection.current.onsignalingstatechange = () => {
                logDebug("Signaling state changed", {
                    state: peerConnection.current.signalingState
                });
            };

            peerConnection.current.onconnectionstatechange = () => {
                const state = peerConnection.current.connectionState;
                logDebug("Connection state changed", { state });
                setConnectionStatus(`WebRTC: ${state}`);

                if (state === 'failed') {
                    logDebug("Connection failed, attempting to restart connection");
                    renewConnection();
                }
            };

            return peerConnection.current;
        } catch (error) {
            logDebug("Error creating peer connection", error);
            alert("Error creating connection: " + error.message);
            throw error;
        }
    };

    const acceptCall = async (clientId) => {
        try {
            logDebug("Accepting call from client", { clientId });
            setCurrentClientId(clientId);
            const room = `${clientId}-${repId}`;
            setRoomId(room);

            // Clear any pending ICE candidates from previous calls
            pendingIceCandidates.current = [];

            // Join the room
            logDebug("Joining room", { room });
            socket.current.emit("join_room", { room });

            // Accept the call in the backend
            logDebug("Sending accept_call to server");
            socket.current.emit("accept_call", {
                client_id: clientId,
                rep_id: repId
            });

            // Create peer connection
            await createPeerConnection(clientId);

            // Create and send offer
            logDebug("Creating offer");
            const offer = await peerConnection.current.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });

            logDebug("Setting local description (offer)");
            await peerConnection.current.setLocalDescription(offer);

            logDebug("Sending offer to client");
            socket.current.emit("offer", {
                offer,
                room
            });

            // Update UI state
            setCallState("active");

            // Remove from pending calls
            setPendingCalls(prev => {
                const newPendingCalls = { ...prev };
                delete newPendingCalls[clientId];
                return newPendingCalls;
            });
        } catch (error) {
            logDebug("Error accepting call", error);
            alert("Error accepting call: " + error.message);
        }
    };

    const rejectCall = (clientId) => {
        logDebug("Rejecting call", { clientId });
        socket.current.emit("reject_call", { client_id: clientId });

        setPendingCalls(prev => {
            const newPendingCalls = { ...prev };
            delete newPendingCalls[clientId];
            return newPendingCalls;
        });
    };

    const endCall = (emitEvent = true) => {
        logDebug("Ending call", { currentClientId, emitEvent });
        if (emitEvent && socket.current && currentClientId) {
            socket.current.emit("end_call", { client_id: currentClientId });
        }

        if (peerConnection.current) {
            peerConnection.current.close();
            peerConnection.current = null;
        }

        // Clear remote video
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }

        setCallState("idle");
        setCurrentClientId(null);
        setRoomId(null);
        setMessages([]);
        setConnectionStatus("Not Connected");

        // Clear pending ICE candidates
        pendingIceCandidates.current = [];
    };

    const sendMessage = () => {
        if (message.trim() !== "" && socket.current && roomId) {
            const messageData = {
                room: roomId,
                message: message,
                sender: repId
            };

            logDebug("Sending message", messageData);
            socket.current.emit("send_message", messageData);
            setMessages(prev => [...prev, { sender: "Admin", text: message }]);
            setMessage("");
        }
    };

    // Function to restart local video if it stops working
    const restartLocalVideo = async () => {
        try {
            logDebug("Attempting to restart local video");
            // Stop any existing tracks
            if (localStream.current) {
                localStream.current.getTracks().forEach(track => track.stop());
            }

            // Get new media stream
            localStream.current = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream.current;
                logDebug("Local video restarted successfully");
            }

            // If in a call, we need to replace tracks in the peer connection
            if (peerConnection.current && callState === "active") {
                const senders = peerConnection.current.getSenders();
                const videoTrack = localStream.current.getVideoTracks()[0];
                const audioTrack = localStream.current.getAudioTracks()[0];

                const videoSender = senders.find(sender =>
                    sender.track && sender.track.kind === 'video'
                );

                const audioSender = senders.find(sender =>
                    sender.track && sender.track.kind === 'audio'
                );

                if (videoSender && videoTrack) {
                    videoSender.replaceTrack(videoTrack);
                    logDebug("Replaced video track in peer connection");
                }

                if (audioSender && audioTrack) {
                    audioSender.replaceTrack(audioTrack);
                    logDebug("Replaced audio track in peer connection");
                }
            }
        } catch (error) {
            logDebug("Error restarting local video", error);
            alert("Error restarting video: " + error.message);
        }
    };

    // Function to check and renew ICE connection if needed
    const renewConnection = async () => {
        if (peerConnection.current && callState === "active") {
            logDebug("Manually renewing connection");

            try {
                // Create a new offer with iceRestart: true to force new ICE candidates
                logDebug("Creating new offer with ICE restart");
                const offer = await peerConnection.current.createOffer({
                    iceRestart: true,
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });

                await peerConnection.current.setLocalDescription(offer);

                socket.current.emit("offer", {
                    offer,
                    room: roomId
                });

                logDebug("Renewal offer sent");
            } catch (error) {
                logDebug("Error during connection renewal", error);

                // If that fails, try recreating the entire peer connection
                logDebug("Attempting to recreate peer connection");

                if (peerConnection.current) {
                    peerConnection.current.close();
                    peerConnection.current = null;
                }

                // Clear pending ICE candidates
                pendingIceCandidates.current = [];

                try {
                    await createPeerConnection(currentClientId);

                    const newOffer = await peerConnection.current.createOffer({
                        offerToReceiveAudio: true,
                        offerToReceiveVideo: true
                    });

                    await peerConnection.current.setLocalDescription(newOffer);

                    socket.current.emit("offer", {
                        offer: newOffer,
                        room: roomId
                    });

                    logDebug("Recreated peer connection and sent new offer");
                } catch (nestedError) {
                    logDebug("Failed to recreate peer connection", nestedError);
                    alert("Failed to reconnect. You may need to end the call and try again.");
                }
            }
        }
    };

    // Add function to handle video errors
    const handleVideoError = (event) => {
        logDebug("Video element error", {
            message: event.target.error?.message || "Unknown error"
        });
    };

    // Toggle microphone function
    const toggleMicrophone = () => {
        if (localStream.current) {
            const audioTracks = localStream.current.getAudioTracks();
            if (audioTracks.length > 0) {
                const enabled = !audioTracks[0].enabled;
                audioTracks[0].enabled = enabled;
                setIsMicMuted(!enabled);

                // Inform the server about the mic state change
                if (socket.current && roomId) {
                    socket.current.emit("media_controls", {
                        room: roomId,
                        type: "audio",
                        enabled: enabled,
                        sender: repId
                    });
                }
            }
        }
    };

    // Toggle video function
    const toggleVideo = () => {
        if (localStream.current) {
            const videoTracks = localStream.current.getVideoTracks();
            if (videoTracks.length > 0) {
                const enabled = !videoTracks[0].enabled;
                videoTracks[0].enabled = enabled;
                setIsVideoOff(!enabled);

                // Inform the server about the video state change
                if (socket.current && roomId) {
                    socket.current.emit("media_controls", {
                        room: roomId,
                        type: "video",
                        enabled: enabled,
                        sender: repId
                    });
                }
            }
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-800 p-6">
            <div className="w-full max-w-4xl bg-white rounded-xl shadow-lg flex flex-col h-[90vh] overflow-hidden">
                {/* Status Bar */}
                <div className="bg-gray-700 p-2 text-white text-sm flex justify-between items-center">
                    <div>Connection: <span className={connectionStatus.includes("Connected") ? "text-green-400" : "text-red-400"}>{connectionStatus}</span></div>
                    <div>User ID: {repId}</div>
                    <div className="flex space-x-2">
                        <button
                            onClick={restartLocalVideo}
                            className="px-2 py-1 bg-yellow-600 text-white rounded-lg text-xs"
                        >
                            Restart Camera
                        </button>
                        <button
                            onClick={renewConnection}
                            className="px-2 py-1 bg-blue-600 text-white rounded-lg text-xs"
                        >
                            Retry Connection
                        </button>
                    </div>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Left: Video & Controls Section */}
                    <div className="w-2/3 flex flex-col bg-gray-900 p-4 overflow-auto">
                        <h2 className="text-white text-xl text-center font-semibold mb-4">Admin Panel</h2>

                        {/* Video container */}
                        <div className="flex-1 grid grid-cols-2 gap-4">
                            {/* Local video */}
                            <div className="relative">
                                <h3 className="text-white text-sm mb-2">Your Camera</h3>
                                <video
                                    ref={localVideoRef}
                                    autoPlay
                                    playsInline
                                    muted
                                    className="w-full h-64 object-cover rounded-lg bg-black"
                                    onError={handleVideoError}
                                ></video>
                            </div>

                            {/* Remote video/audio */}
                            <div className="relative">
                                <h3 className="text-white text-sm mb-2">Client Video</h3>
                                <video
                                    ref={remoteVideoRef}
                                    autoPlay
                                    playsInline
                                    className="w-full h-64 object-cover rounded-lg bg-black"
                                    onError={handleVideoError}
                                ></video>
                            </div>
                        </div>

                        {/* Call controls */}
<div className="mt-4">
    {callState === "active" ? (
        <div className="text-center">
            <div className="flex justify-center items-center space-x-4">
                {/* Microphone Toggle Button */}
                <button
                    onClick={toggleMicrophone}
                    className={`p-3 rounded-full ${isMicMuted ? 'bg-gray-600'  : 'bg-red-600'} hover:bg-opacity-80 transition-all`}
                    title={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        {isMicMuted ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        )}
                    </svg>
                </button>

                {/* Video Toggle Button */}
                <button
                    onClick={toggleVideo}
                    className={`p-3 rounded-full ${isVideoOff ? 'bg-gray-600'  : 'bg-red-600'} hover:bg-opacity-80 transition-all`}
                    title={isVideoOff ? "Turn on camera" : "Turn off camera"}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        {isVideoOff ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        )}
                    </svg>
                </button>

                {/* End Call Button */}
                <button
                    onClick={() => endCall()}
                    className="px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-all"
                >
                    End Call
                </button>
            </div>
            <p className="text-white mt-2">In call with client: {currentClientId}</p>
        </div>
    ) : (
        <div>
            <h3 className="text-white text-lg mb-2">Pending Calls</h3>
            {Object.keys(pendingCalls).length > 0 ? (
                <div className="space-y-2">
                    {Object.keys(pendingCalls).map(clientId => (
                        <div key={clientId} className="bg-gray-800 p-3 rounded-lg flex justify-between items-center">
                            <span className="text-white">{clientId}</span>
                            <div className="space-x-2">
                                <button
                                    onClick={() => acceptCall(clientId)}
                                    className="px-3 py-1 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-all"
                                >
                                    Accept
                                </button>
                                <button
                                    onClick={() => rejectCall(clientId)}
                                    className="px-3 py-1 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition-all"
                                >
                                    Reject
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <p className="text-gray-400 text-center">No pending calls</p>
            )}
        </div>
    )}
</div>

                        {/* Debug logs */}
                        <div className="mt-4 bg-gray-800 p-2 rounded-lg">
                            <h3 className="text-white text-sm mb-1">Debug Logs</h3>
                            <div className="h-32 overflow-y-auto text-xs font-mono bg-black p-2 rounded">
                                {debug.map((log, index) => (
                                    <div key={index} className="text-green-400">{log}</div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Right: Chat Section */}
                    <div className="w-1/3 flex flex-col bg-gray-100">
                        <div className="bg-white p-4 border-b">
                            <h3 className="text-lg font-semibold text-gray-800">Live Chat</h3>
                            {currentClientId && (
                                <p className="text-sm text-gray-500">Chatting with: {currentClientId}</p>
                            )}
                        </div>

                        {/* Chat Messages */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {messages.length > 0 ? (
                                messages.map((msg, index) => (
                                    <div key={index} className={`flex ${msg.sender === "Admin" ? "justify-end" : "justify-start"}`}>
                                        <div
                                            className={`px-4 py-2 rounded-lg ${
                                                msg.sender === "Admin" ? "bg-blue-500 text-white" : "bg-gray-300 text-gray-800"
                                            }`}
                                        >
                                            <p className="text-sm">{msg.text}</p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <p className="text-gray-400 text-sm text-center">No messages yet...</p>
                            )}
                        </div>

                        {/* Chat Input */}
                        <div className="p-4 border-t bg-white text-black flex">
                            <input
                                className="flex-1 border border-black -mx-1 p-2 rounded-l-lg focus:outline-none"
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                placeholder="Type your message..."
                                disabled={!currentClientId}
                                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                            />
                            <button
                                onClick={sendMessage}
                                disabled={!currentClientId}
                                className={`px-4 py-2 mx-1 rounded-r-lg ${
                                    currentClientId
                                        ? "bg-blue-600 text-white"
                                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                                }`}
                            >
                                Send
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}