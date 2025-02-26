"use client"
import { useState, useRef, useEffect } from 'react';
import { io } from "socket.io-client";

export default function Admin() {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const peerConnection = useRef(null);
    const socket = useRef(null);
    const localStream = useRef(null);
    
    const [callState, setCallState] = useState("idle"); // idle, incoming, active
    const [pendingCalls, setPendingCalls] = useState({});
    const [currentClientId, setCurrentClientId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [message, setMessage] = useState("");
    const [repId, setRepId] = useState(`rep-${Math.floor(Math.random() * 10000)}`);
    const [roomId, setRoomId] = useState(null);

    const SERVER_URL = "http://localhost:3001";

    useEffect(() => {
        // Initialize Socket.IO connection
        socket.current = io(SERVER_URL);
        
        // Get pending calls
        const fetchPendingCalls = async () => {
            try {
                const response = await fetch(`${SERVER_URL}/get_pending_calls`);
                const data = await response.json();
                setPendingCalls(data.pending_calls || {});
            } catch (error) {
                console.error("Error fetching pending calls:", error);
            }
        };

        fetchPendingCalls();

        // Start local stream
        const startLocalStream = async () => {
            try {
                localStream.current = await navigator.mediaDevices.getUserMedia({ 
                    video: true, 
                    audio: true 
                });
                
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = localStream.current;
                }
            } catch (error) {
                console.error("Error accessing media devices:", error);
            }
        };

        startLocalStream();

        // Socket event listeners
        socket.current.on("new_call", (data) => {
            setPendingCalls(prev => ({
                ...prev,
                [data.client_id]: "waiting"
            }));
        });

        socket.current.on("call_ended", (data) => {
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
            setMessages(prev => [...prev, { 
                sender: "Client", 
                text: data.message 
            }]);
        });

        socket.current.on("answer", (data) => {
            if (peerConnection.current) {
                peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        });

        socket.current.on("ice_candidate", (data) => {
            if (peerConnection.current) {
                peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        });

        // Check for pending calls periodically
        const interval = setInterval(fetchPendingCalls, 5000);

        return () => {
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
            localStream.current.getTracks().forEach(track => track.stop());
            localStream.current = null;
        }
    };

    const createPeerConnection = async (clientId) => {
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
            if (localStream.current) {
                localStream.current.getTracks().forEach(track => {
                    peerConnection.current.addTrack(track, localStream.current);
                });
            }
            
            // Set up event handlers for the peer connection
            peerConnection.current.ontrack = (event) => {
                remoteVideoRef.current.srcObject = event.streams[0];
            };
            
            peerConnection.current.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.current.emit("ice_candidate", {
                        candidate: event.candidate,
                        room: roomId
                    });
                }
            };

            return peerConnection.current;
        } catch (error) {
            console.error("Error creating peer connection:", error);
        }
    };

    const acceptCall = async (clientId) => {
        try {
            setCurrentClientId(clientId);
            const room = `${clientId}-${repId}`;
            setRoomId(room);
            
            // Join the room
            socket.current.emit("join_room", { room });
            
            // Accept the call in the backend
            socket.current.emit("accept_call", {
                client_id: clientId,
                rep_id: repId
            });
            
            // Create peer connection
            await createPeerConnection(clientId);
            
            // Create and send offer
            const offer = await peerConnection.current.createOffer();
            await peerConnection.current.setLocalDescription(offer);
            
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
            console.error("Error accepting call:", error);
        }
    };

    const rejectCall = (clientId) => {
        socket.current.emit("reject_call", { client_id: clientId });
        
        setPendingCalls(prev => {
            const newPendingCalls = { ...prev };
            delete newPendingCalls[clientId];
            return newPendingCalls;
        });
    };

    const endCall = (emitEvent = true) => {
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
    };

    const sendMessage = () => {
        if (message.trim() !== "" && socket.current && roomId) {
            const messageData = {
                room: roomId,
                message: message,
                sender: repId
            };
            
            socket.current.emit("send_message", messageData);
            setMessages(prev => [...prev, { sender: "Admin", text: message }]);
            setMessage("");
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-800 p-6">
            <div className="w-full max-w-4xl bg-white rounded-xl shadow-lg flex h-[90vh] overflow-hidden">
                {/* Left: Video & Controls Section */}
                <div className="w-2/3 flex flex-col bg-gray-900 p-4">
                    <h2 className="text-white text-xl text-center font-semibold mb-4">Admin Panel</h2>
                    
                    {/* Video container */}
                    <div className="flex-1 grid grid-cols-2 gap-4">
                        {/* Local video */}
                        <div className="relative">
                            <h3 className="text-white text-sm mb-2">Your Camera</h3>
                            <video ref={localVideoRef} autoPlay muted className="w-full h-64 object-cover rounded-lg bg-black"></video>
                        </div>
                        
                        {/* Remote video/audio */}
                        <div className="relative">
                            <h3 className="text-white text-sm mb-2">Client Video</h3>
                            <video ref={remoteVideoRef} autoPlay className="w-full h-64 object-cover rounded-lg bg-black"></video>
                        </div>
                    </div>
                    
                    {/* Call controls */}
                    <div className="mt-4">
                        {callState === "active" ? (
                            <div className="text-center">
                                <button 
                                    onClick={() => endCall()} 
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg"
                                >
                                    End Call
                                </button>
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
                                                        className="px-3 py-1 bg-green-600 text-white rounded-lg text-sm"
                                                    >
                                                        Accept
                                                    </button>
                                                    <button 
                                                        onClick={() => rejectCall(clientId)} 
                                                        className="px-3 py-1 bg-red-600 text-white rounded-lg text-sm"
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
                    <div className="p-4 border-t bg-white flex">
                        <input
                            className="flex-1 border p-2 rounded-l-lg focus:outline-none"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Type your message..."
                            disabled={!currentClientId}
                            onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        />
                        <button 
                            onClick={sendMessage} 
                            disabled={!currentClientId}
                            className={`px-4 py-2 rounded-r-lg ${
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
    );
}