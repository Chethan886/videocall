import { useState, useRef, useEffect } from 'react';

export default function Client() {
    const remoteVideoRef = useRef(null);
    const pc = useRef(null);
    const ws = useRef(null);
    const [callStatus, setCallStatus] = useState("Request a call");

    useEffect(() => {
        ws.current = new WebSocket('ws://localhost:3002');

        ws.current.onmessage = async event => {
            const data = JSON.parse(event.data);

            if (data.type === 'offer') {
                setCallStatus("Call accepted. Connecting...");
                await pc.current.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.current.createAnswer();
                await pc.current.setLocalDescription(answer);
                ws.current.send(JSON.stringify({ type: 'answer', answer }));

                // Capture and send the client's audio stream
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => {
                        stream.getTracks().forEach(track => pc.current.addTrack(track, stream));
                    })
                    .catch(error => console.error("Error accessing microphone:", error));
            } else if (data.type === 'candidate') {
                pc.current.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        };

        pc.current = new RTCPeerConnection();

        fetch('http://localhost:3001/get-turn-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .then(res => res.json())
            .then(data => pc.current.setConfiguration({ iceServers: data.iceServers }));

        pc.current.ontrack = event => {
            remoteVideoRef.current.srcObject = event.streams[0];
        };

        pc.current.onicecandidate = event => {
            if (event.candidate) {
                ws.current.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };
    }, []);

    const requestCall = () => {
        setCallStatus("Waiting for admin to accept your call...");
        ws.current.send(JSON.stringify({ type: 'request-call' }));
    };

    return (
        <div>
            <h1>Client Page</h1>
            <video ref={remoteVideoRef} autoPlay></video>
            {callStatus === "Request a call" && <button onClick={requestCall}>Request Call</button>}
            <p>{callStatus}</p>
        </div>
    );
}
