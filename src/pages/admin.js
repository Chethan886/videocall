import { useState, useRef, useEffect } from 'react';

export default function Admin() {
    const localVideoRef = useRef(null);
    const pc = useRef(null);
    const ws = useRef(null);
    const [callInProgress, setCallInProgress] = useState(false);

    useEffect(() => {
        ws.current = new WebSocket('ws://3.87.251.192:5000');

        ws.current.onmessage = event => {
            const data = JSON.parse(event.data);

            if (data.type === 'answer') {
                pc.current.setRemoteDescription(new RTCSessionDescription(data.answer));
            } else if (data.type === 'candidate') {
                pc.current.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        };

        pc.current = new RTCPeerConnection();
        pc.current.ontrack = event => {
            if (!remoteVideoRef.current.srcObject) {
                remoteVideoRef.current.srcObject = event.streams[0];
            } else {
                event.streams[0].getAudioTracks().forEach(track => {
                    remoteVideoRef.current.srcObject.addTrack(track);
                });
            }
        };
        
        navigator.mediaDevices.getUserMedia({ video: true, audio: true })
            .then(stream => {
                localVideoRef.current.srcObject = stream;
                stream.getTracks().forEach(track => pc.current.addTrack(track, stream));
            });

        fetch('http://3.87.251.192:3001/get-turn-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .then(res => res.json())
            .then(data => pc.current.setConfiguration({ iceServers: data.iceServers }));

        pc.current.onicecandidate = event => {
            if (event.candidate) {
                ws.current.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };
    }, []);

    const startCall = async () => {
        setCallInProgress(true);
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        ws.current.send(JSON.stringify({ type: 'offer', offer }));
    };

    return (
        <div>
            <h1>Admin Page</h1>
            <video ref={localVideoRef} autoPlay muted></video>
            {!callInProgress && <button onClick={startCall}>Start Call</button>}
            {callInProgress && <p>Call in progress...</p>}
        </div>
    );
}
