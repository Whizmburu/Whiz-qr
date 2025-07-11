// Frontend JavaScript - script.js
// This file will handle interactions with the backend (server.js) via WebSocket

let socket;

function connectWebSocket() {
    // Determine WebSocket protocol based on current window protocol
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('WebSocket connection established. Path:', window.location.pathname);
        // Inform the backend which page is active, if necessary, or send initial request
        const path = window.location.pathname;
        // Path can be /qr or /qr.html (or /views/qr.ejs if accessed directly, though not typical)
        if (path.endsWith('/qr') || path.includes('qr.html') || path.includes('qr.ejs')) {
            console.log('QR page detected, sending requestQr.');
            socket.send(JSON.stringify({ type: 'requestQr' }));
        } else {
            console.log('Not on QR page, or path not recognized for initial QR request:', path);
        }
        // For pairing code, the request is typically triggered by a button click after entering phone number
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Message from server:', data);

        const statusMessage = document.getElementById('status-message'); // General status element

        switch (data.event) {
            case 'qrUpdate':
                const qrCodeContainer = document.getElementById('qr-code-container');
                if (qrCodeContainer && data.qr) {
                    qrCodeContainer.innerHTML = `<img src="${data.qr}" alt="QR Code">`;
                    if (statusMessage) statusMessage.textContent = 'Scan the QR code. Waiting for connection...';
                } else if (qrCodeContainer) {
                    qrCodeContainer.innerHTML = `<p class="error">Received QR update but no QR data.</p>`;
                }
                break;
            case 'pairingCodeGenerated':
                const pairingCodeContainer = document.getElementById('pairing-code-container');
                if (pairingCodeContainer && data.pairingCode) {
                    pairingCodeContainer.innerHTML = `<p>Your Pairing Code: <strong>${data.pairingCode}</strong></p>`;
                    if (statusMessage) statusMessage.textContent = 'Enter this code in your WhatsApp linked devices screen.';
                } else if (pairingCodeContainer) {
                     pairingCodeContainer.innerHTML = `<p class="error">Received pairing code event but no code.</p>`;
                }
                break;
            case 'pairingSuccess':
                if (statusMessage) {
                    statusMessage.textContent = `${data.message} Session ID: ${data.sessionId}`;
                    statusMessage.className = 'success';
                }
                // Disable inputs on success
                if (document.getElementById('phone-number-qr')) document.getElementById('phone-number-qr').disabled = true;
                if (document.getElementById('phone-number-code')) document.getElementById('phone-number-code').disabled = true;
                if (document.getElementById('generate-code-btn')) document.getElementById('generate-code-btn').disabled = true;
                break;
            case 'statusUpdate':
                if (statusMessage) {
                    statusMessage.textContent = data.message;
                    statusMessage.className = ''; // Reset class
                }
                break;
            case 'errorMessage':
                if (statusMessage) {
                    statusMessage.textContent = `Error: ${data.message}`;
                    statusMessage.className = 'error';
                }
                 // Also display in specific containers if they exist
                const qrErrorDisp = document.getElementById('qr-code-container');
                const codeErrorDisp = document.getElementById('pairing-code-container');
                if (qrErrorDisp && window.location.pathname.includes('qr.html')) qrErrorDisp.innerHTML = `<p class="error">Error: ${data.message}</p>`;
                if (codeErrorDisp && window.location.pathname.includes('pairing_code.html')) codeErrorDisp.innerHTML = `<p class="error">Error: ${data.message}</p>`;
                break;
            default:
                console.log('Received unknown event:', data);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        const statusMessage = document.getElementById('status-message');
        if (statusMessage) {
            statusMessage.textContent = 'WebSocket connection error. Please ensure the server is running and try refreshing.';
            statusMessage.className = 'error';
        }
        const qrCodeContainer = document.getElementById('qr-code-container');
        if (qrCodeContainer && window.location.pathname.includes('qr.html')) {
             qrCodeContainer.innerHTML = `<p class="error">WebSocket connection error.</p>`;
        }
        const pairingCodeContainer = document.getElementById('pairing-code-container');
        if (pairingCodeContainer && window.location.pathname.includes('pairing_code.html')) {
             pairingCodeContainer.innerHTML = `<p class="error">WebSocket connection error.</p>`;
        }
    };

    socket.onclose = () => {
        console.log('WebSocket connection closed.');
        const statusMessage = document.getElementById('status-message');
        // Avoid showing "closed" if it was a successful pairing leading to page unload or redirection
        if (statusMessage && statusMessage.className !== 'success') {
            // statusMessage.textContent = 'WebSocket connection closed. You may need to refresh.';
            // statusMessage.className = 'error';
        }
    };
}


document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket(); // Establish WebSocket connection as soon as DOM is loaded

    const path = window.location.pathname;
    console.log('DOMContentLoaded. Current path:', path);

    // Path can be /qr or /qr.html (or /views/qr.ejs if accessed directly, though not typical)
    if (path.endsWith('/qr') || path.includes('qr.html') || path.includes('qr.ejs')) {
        console.log('Initializing QR Page');
        initQrPage();
    } else if (path.endsWith('/pairing-code') || path.includes('pairing_code.html') || path.includes('pairing_code.ejs')) {
        console.log('Initializing Pairing Code Page');
        initPairingCodePage();
    } else {
        console.log('On index page or unknown path, no specific page init.');
    }
});

function initQrPage() {
    const qrCodeContainer = document.getElementById('qr-code-container');
    const statusMessage = document.getElementById('status-message');
    const phoneNumberInputQr = document.getElementById('phone-number-qr');

    statusMessage.textContent = 'Connecting to server for QR Code...';
    qrCodeContainer.innerHTML = '<p>Waiting for QR code from server...</p>';

    // The actual QR request is sent when WebSocket connects (see socket.onopen)
    // or if the user updates their phone number for confirmation later.

    // Optional: if phone number is changed, resend it (though server stores it on first request)
    phoneNumberInputQr.addEventListener('change', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            // This message type isn't explicitly handled by server for just phone update post-qr-request
            // The server associates the phone number on the 'requestQr' message.
            // For simplicity, we assume the number entered *before* QR is displayed is the one used.
            // Or, modify server to handle 'updatePhoneNumber' if needed.
            console.log("Phone number for QR confirmation changed to: " + phoneNumberInputQr.value);
             // To be safe, we could re-trigger a request or send an update.
             // For now, the server uses the phone number from the initial 'requestQr' message.
             // If QR is already displayed, this change won't re-trigger Baileys on server.
             // The server needs to store this phone number with the specific WS client session.
        }
    });
}

function initPairingCodePage() {
    const pairingCodeContainer = document.getElementById('pairing-code-container');
    const statusMessage = document.getElementById('status-message');
    const phoneNumberInputCode = document.getElementById('phone-number-code');
    const generateCodeBtn = document.getElementById('generate-code-btn');

    if (generateCodeBtn) {
        console.log('Pairing Code Page: Generate Code button (generate-code-btn) found, attaching listener.');
        generateCodeBtn.addEventListener('click', () => {
            console.log('Pairing Code Page: Generate Code button clicked.');
            const phoneNumber = phoneNumberInputCode.value.trim();

            if (!phoneNumber || !/^\d{10,15}$/.test(phoneNumber)) {
                console.log('Pairing Code Page: Invalid phone number entered:', phoneNumber);
                statusMessage.textContent = 'Please enter a valid phone number (e.g., 2547xxxxxxxx, 10-15 digits).';
                statusMessage.className = 'error';
                pairingCodeContainer.innerHTML = ''; // Clear previous code/message
                return;
            }

            console.log('Pairing Code Page: Phone number is valid:', phoneNumber, '- Checking WebSocket state.');
            statusMessage.textContent = 'Requesting Pairing Code...';
            statusMessage.className = ''; // Reset class
            pairingCodeContainer.innerHTML = '<p>Waiting for pairing code from server...</p>';

            if (socket && socket.readyState === WebSocket.OPEN) {
                console.log('Pairing Code Page: WebSocket is open, sending requestCode for:', phoneNumber);
                socket.send(JSON.stringify({ type: 'requestCode', phoneNumber: phoneNumber }));
            } else {
                const socketState = socket ? socket.readyState : 'socket is null';
                console.error('Pairing Code Page: WebSocket not connected or not open. State:', socketState,
                              '(0:CONNECTING, 1:OPEN, 2:CLOSING, 3:CLOSED)');
                statusMessage.textContent = 'WebSocket not connected. Please refresh the page and try again.';
                statusMessage.className = 'error';
                pairingCodeContainer.innerHTML = '<p class="error">Cannot request code. Connection issue.</p>';
            }
        });
    } else {
        console.error('Pairing Code Page: Generate Code button (generate-code-btn) NOT found.');
    }
}

// Removed the old listenForPairingSuccess as WebSocket handles this now.
