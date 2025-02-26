"use client";
import { useState, useRef, useEffect } from "react";
import { io } from "socket.io-client";

export default function Client() {
    const remoteVideoRef = useRef(null);
    const localVideoRef = useRef(null);
    const peerConnection = useRef(null);
    const socket = useRef(null);
    const localStream = useRef(null);
    const pendingIceCandidates = useRef([]);
    
    const [callStatus, setCallStatus] = useState("Request a call");
    const [messages, setMessages] = useState([]);
    const [message, setMessage] = useState("");
    const [clientId, setClientId] = useState("");
    const [roomId, setRoomId] = useState(null);
    const [isMicMuted, setIsMicMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);

    const SERVER_URL = "http://3.87.251.192:3001";

    // Generate or retrieve client ID
    useEffect(() => {
        const storedClientId = localStorage.getItem("clientId");
        if (storedClientId) {
            setClientId(storedClientId);
        } else {
            const newClientId = `client-${Math.floor(Math.random() * 10000)}`;
            setClientId(newClientId);
            localStorage.setItem("clientId", newClientId);
        }
    }, []);

    useEffect(() => {
        if (!clientId) return; // Don't initialize until clientId is set
        
        // Initialize Socket.IO connection
        socket.current = io(SERVER_URL);

        // Check if client is already in a call
        const checkClientStatus = async () => {
            try {
                const response = await fetch(`${SERVER_URL}/check_client`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: clientId })
                });
                
                const data = await response.json();
                if (data.active) {
                    setCallStatus("Call in progress");
                    setRoomId(data.room_id);
                    await startCall(data.room_id); // Reinitialize the call
                }
            } catch (error) {
                console.error("Error checking client status:", error);
            }
        };

        checkClientStatus();
        
        // Socket event listeners
        socket.current.on("call_accepted", async (data) => {
            if (data.client_id === clientId) {
                const roomId = `${data.client_id}-${data.rep_id}`;
                setRoomId(roomId);
                setCallStatus("Call accepted. Connecting...");
                
                // Join the room
                socket.current.emit("join_room", { room: roomId });
                
                // Start WebRTC connection
                await startCall(roomId);
            }
        });

        socket.current.on("call_rejected", (data) => {
            if (data.client_id === clientId) {
                setCallStatus("Call rejected by admin");
                setTimeout(() => setCallStatus("Request a call"), 3000);
            }
        });

        socket.current.on("call_ended", (data) => {
            if (data.client_id === clientId) {
                setCallStatus("Call ended");
                endLocalStream();
                if (peerConnection.current) {
                    peerConnection.current.close();
                    peerConnection.current = null;
                }
                setTimeout(() => setCallStatus("Request a call"), 3000);
            }
        });

        socket.current.on("receive_message", (data) => {
            setMessages((prev) => [...prev, { sender: "Admin", text: data.message }]);
        });

        socket.current.on("offer", async (data) => {
            try {
                if (!peerConnection.current) {
                    await createPeerConnection(data.room);
                }
                
                await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.offer));
                
                // After setting remote description, add any pending ICE candidates
                if (pendingIceCandidates.current.length > 0) {
                    const promises = pendingIceCandidates.current.map(candidate => 
                        peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate))
                    );
                    await Promise.all(promises);
                    pendingIceCandidates.current = []; // Clear the array
                }
                
                const answer = await peerConnection.current.createAnswer();
                await peerConnection.current.setLocalDescription(answer);
                
                socket.current.emit("answer", {
                    answer,
                    room: data.room
                });
            } catch (error) {
                console.error("Error handling offer:", error);
            }
        });

        socket.current.on("ice_candidate", (data) => {
            if (peerConnection.current) {
                // If we already have a remote description set, add the candidate immediately
                if (peerConnection.current.remoteDescription) {
                    peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate))
                        .catch(err => console.error("Error adding received ice candidate", err));
                } else {
                    // Otherwise store it in the pending candidates array
                    pendingIceCandidates.current.push(data.candidate);
                }
            }
        });
        
        socket.current.on("answer", async (data) => {
            try {
                if (peerConnection.current) {
                    await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.answer));
                    
                    // After setting remote description, add any pending ICE candidates
                    if (pendingIceCandidates.current.length > 0) {
                        const promises = pendingIceCandidates.current.map(candidate => 
                            peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate))
                        );
                        await Promise.all(promises);
                        pendingIceCandidates.current = []; // Clear the array
                    }
                }
            } catch (error) {
                console.error("Error handling answer:", error);
            }
        });

        socket.current.on("media_controls", (data) => {
            // Handle media control events (mute/unmute, etc.)
            console.log("Media control event:", data);
        });

        return () => {
            endLocalStream();
            if (peerConnection.current) {
                peerConnection.current.close();
            }
            if (socket.current) {
                socket.current.disconnect();
            }
        };
    }, [clientId]);

    const endLocalStream = () => {
        if (localStream.current) {
            localStream.current.getTracks().forEach(track => track.stop());
            localStream.current = null;
        }
    };

    const createPeerConnection = async (room) => {
        try {
            // Get TURN server credentials
            const response = await fetch(`${SERVER_URL}/get-turn-credentials`, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });
            
            const data = await response.json();
            
            // Create new RTCPeerConnection with TURN servers
            peerConnection.current = new RTCPeerConnection({
                iceServers: data.iceServers
            });
            
            // Add local stream to peer connection
            if (!localStream.current) {
                localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                localVideoRef.current.srcObject = localStream.current;
            }
            
            localStream.current.getTracks().forEach(track => {
                peerConnection.current.addTrack(track, localStream.current);
            });
            
            // Set up event handlers for the peer connection
            peerConnection.current.ontrack = (event) => {
                remoteVideoRef.current.srcObject = event.streams[0];
            };
            
            peerConnection.current.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.current.emit("ice_candidate", {
                        candidate: event.candidate,
                        room
                    });
                }
            };

            return peerConnection.current;
        } catch (error) {
            console.error("Error creating peer connection:", error);
            setCallStatus("Failed to connect. Try again.");
            setTimeout(() => setCallStatus("Request a call"), 3000);
        }
    };

    const startCall = async (room) => {
        try {
            await createPeerConnection(room);
            
            // Create and send offer
            const offer = await peerConnection.current.createOffer();
            await peerConnection.current.setLocalDescription(offer);
            
            socket.current.emit("offer", {
                offer,
                room
            });
        } catch (error) {
            console.error("Error starting call:", error);
            setCallStatus("Failed to connect. Try again.");
            setTimeout(() => setCallStatus("Request a call"), 3000);
        }
    };

    const requestCall = async () => {
        try {
            setCallStatus("Requesting call...");
            
            const response = await fetch(`${SERVER_URL}/request_call`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ client_id: clientId })
            });
            
            const data = await response.json();
            
            if (response.status === 200) {
                setCallStatus("Waiting for admin to accept your call...");
            } else if (response.status === 409) {
                setCallStatus("You already have an active call");
                setTimeout(() => setCallStatus("Request a call"), 3000);
            } else {
                setCallStatus("Error requesting call");
                setTimeout(() => setCallStatus("Request a call"), 3000);
            }
        } catch (error) {
            console.error("Error requesting call:", error);
            setCallStatus("Error requesting call");
            setTimeout(() => setCallStatus("Request a call"), 3000);
        }
    };

    const endCall = () => {
        if (socket.current) {
            socket.current.emit("end_call", { client_id: clientId });
        }
        
        endLocalStream();
        
        if (peerConnection.current) {
            peerConnection.current.close();
            peerConnection.current = null;
        }
        
        setCallStatus("Call ended");
        setTimeout(() => setCallStatus("Request a call"), 3000);
    };

    const toggleMicrophone = () => {
        if (localStream.current) {
            const audioTracks = localStream.current.getAudioTracks();
            if (audioTracks.length > 0) {
                const enabled = !audioTracks[0].enabled;
                audioTracks[0].enabled = enabled;
                setIsMicMuted(!enabled);
                
                console.log(`Microphone ${enabled ? "Enabled" : "Disabled"}`);
                
                // Inform the server about the mic state change
                if (socket.current && roomId) {
                    socket.current.emit("media_controls", {
                        room: roomId,
                        type: "audio",
                        enabled: enabled,
                        client_id: clientId
                    });
                }
            } else {
                console.error("No audio tracks found!");
            }
        } else {
            console.error("No local stream found!");
        }
    };
    
    const toggleVideo = () => {
        if (localStream.current) {
            const videoTracks = localStream.current.getVideoTracks();
            if (videoTracks.length > 0) {
                const enabled = !videoTracks[0].enabled;
                videoTracks[0].enabled = enabled;
                setIsVideoOff(!enabled);
                
                console.log(`Video ${enabled ? "Enabled" : "Disabled"}`);
                
                // Inform the server about the video state change
                if (socket.current && roomId) {
                    socket.current.emit("media_controls", {
                        room: roomId,
                        type: "video",
                        enabled: enabled,
                        client_id: clientId
                    });
                }
            } else {
                console.error("No video tracks found!");
            }
        } else {
            console.error("No local stream found!");
        }
    };
      
    const sendMessage = () => {
        if (message.trim() !== "" && socket.current) {
            const messageData = {
                room: roomId,
                message: message,
                sender: clientId
            };
            
            socket.current.emit("send_message", messageData);
            setMessages((prev) => [...prev, { sender: "You", text: message }]);
            setMessage("");
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-100 p-6">
            <div className="w-full max-w-4xl bg-white rounded-xl shadow-lg flex h-[90vh] overflow-hidden relative">
                {/* Left: Video Section */}
                <div className="w-2/3 flex flex-col bg-gray-900 p-4">
                    <h2 className="text-white text-lg text-center font-semibold mb-4">Live Video Call</h2>
                    <div className="flex-1 flex items-center justify-center relative">
                        {/* Remote Video (Main) */}
                        <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover rounded-lg"></video>
                        
                        {/* Local Video (Picture-in-Picture) */}
                        <div className="absolute bottom-4 right-4 w-1/4 h-1/4">
                            <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover rounded-lg"></video>
                        </div>
                        
                        {callStatus !== "Call accepted. Connecting..." && 
                         callStatus !== "Waiting for admin to accept your call..." && 
                         callStatus !== "Call in progress" && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-lg">
                                <p className="text-white text-lg font-medium">No active call</p>
                            </div>
                        )}
                    </div>
                    
                    {/* Media Controls */}
                    <div className="mt-4 flex justify-center items-center space-x-4">
                        {(callStatus === "Call accepted. Connecting..." || callStatus === "Call in progress") && (
                            <>
                                <button 
                                    onClick={toggleMicrophone} 
                                    className={`p-2 rounded-full ${isMicMuted ? 'bg-gray-600'  : 'bg-red-600'}`}
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
                                <button 
                                    onClick={toggleVideo} 
                                    className={`p-2 rounded-full ${isVideoOff ?'bg-gray-600'  : 'bg-red-600'}`}
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
                                <button onClick={endCall} className="px-4 py-2 bg-red-600 text-white rounded-lg">
                                    End Call
                                </button>
                            </>
                        )}
                        
                        {callStatus === "Request a call" && (
                            <button onClick={requestCall} className="px-4 py-2 bg-blue-600 text-white rounded-lg">
                                Request Call
                            </button>
                        )}
                        
                        {callStatus !== "Request a call" && 
                         callStatus !== "Call accepted. Connecting..." && 
                         callStatus !== "Call in progress" && (
                            <p className="text-white">{callStatus}</p>
                        )}
                    </div>
                </div>

                {/* Right: Chat Section */}
                <div className="w-1/3 flex flex-col bg-gray-100">
                    <div className="bg-white p-4 border-b">
                        <h3 className="text-lg font-semibold text-gray-800">Live Chat</h3>
                        <p className="text-sm text-gray-500">Client ID: {clientId}</p>
                    </div>

                    {/* Chat Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        {messages.length > 0 ? (
                            messages.map((msg, index) => (
                                <div key={index} className={`flex ${msg.sender === "You" ? "justify-end" : "justify-start"}`}>
                                    <div
                                        className={`px-4 py-2 rounded-lg ${
                                            msg.sender === "You" ? "bg-blue-500 text-white" : "bg-gray-300 text-gray-800"
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
                            onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        />
                        <button onClick={sendMessage} className="px-4 mx-2 py-2  bg-blue-600 text-white rounded-lg">
                            Send
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}