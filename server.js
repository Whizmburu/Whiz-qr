const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises; // Use promises for fs operations

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Store active Baileys sockets and their associated WebSockets
// For simplicity, this example manages one main Baileys instance.
// A real multi-user app would need more sophisticated session management.
let sock = null;
let clientWs = null; // The WebSocket connection to the frontend client
let pairingData = {
    qr: null,
    pairingCode: null,
    status: 'disconnected', // disconnected, connecting, qr, code_requested, connected
    userPhoneNumber: null, // Phone number to send confirmation to
    sessionId: null
};

const sessionsDir = path.join(__dirname, 'auth_info_baileys');

// Ensure the sessions directory exists
async function ensureSessionsDir() {
    try {
        await fs.mkdir(sessionsDir, { recursive: true });
        console.log(`Directory ${sessionsDir} ensured.`);
    } catch (error) {
        console.error('Error creating sessions directory:', error);
    }
}
ensureSessionsDir();


async function startBaileys(type, phoneNumberForPairingCode = null) {
    if (sock) {
        console.log('Baileys socket already exists. Closing existing one before starting new.');
        try {
            await sock.logout(); // or sock.end(new Error('Starting new session'))
        } catch (e) {
            console.error('Error closing existing Baileys socket:', e);
        }
        sock = null;
    }

    pairingData = { // Reset pairing data
        qr: null,
        pairingCode: null,
        status: 'connecting',
        userPhoneNumber: type === 'code' ? phoneNumberForPairingCode : null,
        sessionId: null
    };

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Initializing WhatsApp connection...' }));
    }

    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, `session-${type}`));

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We'll send it via WebSocket
        browser: Browsers.macOS('Desktop'),
        logger: require('pino')({ level: 'silent' }) //প্রেমিকা একটি মাল্টিডিভাইস, ধন্যবাদ
    });

    // For Pairing Code
    if (type === 'code' && phoneNumberForPairingCode && !sock.authState.creds.registered) {
        console.log(`Requesting pairing code for ${phoneNumberForPairingCode}`);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Requesting pairing code...' }));
        }
        try {
            // Ensure the phone number is stripped of any non-digits and '+'
            const formattedPhoneNumber = phoneNumberForPairingCode.replace(/\D/g, '');
            if (!formattedPhoneNumber) {
                throw new Error("Invalid phone number for pairing code.");
            }
            const code = await sock.requestPairingCode(formattedPhoneNumber);
            pairingData.pairingCode = code;
            pairingData.status = 'code_requested';
            console.log(`Pairing code: ${code}`);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: code }));
            }
        } catch (error) {
            console.error('Error requesting pairing code:', error);
            pairingData.status = 'error';
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'errorMessage', message: `Error requesting pairing code: ${error.message}` }));
            }
            return; // Stop further processing for this connection
        }
    }


    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('Connection update:', update);

        if (qr) {
            pairingData.qr = await qrcode.toDataURL(qr);
            pairingData.status = 'qr';
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
            }
        }

        if (connection === 'close') {
            pairingData.status = 'disconnected';
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);

            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                 clientWs.send(JSON.stringify({ event: 'statusUpdate', message: `Connection Closed: ${lastDisconnect.error}. ${shouldReconnect ? 'Attempting to reconnect...' : 'Logged out.'}` }));
            }
            if (shouldReconnect) {
                // startBaileys(type, pairingData.userPhoneNumber); // Reconnect logic might be needed here
            } else {
                console.log("Logged out, not reconnecting. Cleaning up session.");
                 try {
                    // Optional: Clean up session files on logout
                    // await fs.rm(path.join(sessionsDir, `session-${type}`), { recursive: true, force: true });
                    // console.log(`Session data for session-${type} cleaned up.`);
                } catch (e) {
                    console.error("Error cleaning up session data:", e);
                }
                sock = null; // Clear the socket
                 if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Logged out. Please restart pairing if needed.'}));
                }
            }
        } else if (connection === 'open') {
            pairingData.status = 'connected';
            const sessionNumber = sock.authState.creds.me.id.split(':')[0];
            pairingData.sessionId = `WHIZMD_${sessionNumber}`;
            console.log(`Connected! Session ID: ${pairingData.sessionId}`);

            const successMessage = `❀━━━━ HELLO DEAR ━━━━━ ╮ ❀\n*👏WHIZ-MD CONNECTED*👏\n\n❀ Congrats🎊First Step of Making a bot ❀ is successfuly completed🎊\n❀ Owner : +254754783683\n❀ Group : https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM\n❀ Version : 1.0.0\n❀ Repo : github.com/whizmburu/whiz-md\n\nSession ID: ${pairingData.sessionId}\n\nDont know to deploy? Visit : https://github.com/Whizmburu/whiz-md/tree/main#-deployment\n❀━━━━━━━━━━━━━━━━━╯`;

            let targetPhoneNumber = pairingData.userPhoneNumber || sessionNumber; // Use provided number or the paired number
            if (!targetPhoneNumber.includes('@s.whatsapp.net')) {
                 targetPhoneNumber = `${targetPhoneNumber}@s.whatsapp.net`;
            }

            try {
                await sock.sendMessage(targetPhoneNumber, { text: successMessage });
                console.log(`Success message sent to ${targetPhoneNumber}`);
                 if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        event: 'pairingSuccess',
                        message: `Successfully paired! Confirmation sent to ${pairingData.userPhoneNumber || 'your WhatsApp'}.`,
                        sessionId: pairingData.sessionId,
                        phoneNumber: pairingData.userPhoneNumber || sessionNumber
                    }));
                }
            } catch (err) {
                console.error('Failed to send success message:', err);
                 if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        event: 'pairingSuccess', // Still paired, but message failed
                        message: `Successfully paired! BUT failed to send confirmation message. Session ID: ${pairingData.sessionId}`,
                        sessionId: pairingData.sessionId,
                        errorOnSend: true
                    }));
                }
            }
            // Consider closing the Baileys socket if only one-time pairing is needed per server start
            // await sock.logout();
            // sock = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// HTTP endpoint to initiate pairing (primarily for initial request from HTML pages)
// Actual QR/code data will be sent over WebSocket
app.get('/start-pairing', async (req, res) => {
    const type = req.query.type; // 'qr' or 'code'
    const phoneNumber = req.query.phoneNumber; // For pairing code

    if (type === 'code' && (!phoneNumber || !/^\d+$/.test(phoneNumber))) {
        return res.status(400).json({ error: 'Valid phone number is required for pairing code.' });
    }

    // Client should connect via WebSocket after this
    // If already connecting/connected, this endpoint might just acknowledge
    if (pairingData.status === 'connecting' || pairingData.status === 'qr' || pairingData.status === 'code_requested' || pairingData.status === 'connected') {
         console.log(`Pairing process already active with status: ${pairingData.status}`);
         // Send current state if client is just re-requesting
         if (type === 'qr' && pairingData.qr) {
            return res.json({ qr: pairingData.qr, message: "Pairing in progress, QR already generated." });
         }
         if (type === 'code' && pairingData.pairingCode) {
             return res.json({ pairingCode: pairingData.pairingCode, message: "Pairing in progress, code already generated." });
         }
         // If no specific data yet but process active
         return res.json({ message: `Pairing process active (${pairingData.status}). Connect via WebSocket for updates.` });
    }

    console.log(`Received request to start pairing: type=${type}, phone=${phoneNumber}`);

    // The actual Baileys start will be triggered by WebSocket connection usually,
    // but for direct HTTP GET to kick things off:
    // We will rely on the client connecting via WebSocket to get the QR/code.
    // This HTTP endpoint mainly signals the intent.

    // For QR, we can send the QR if it's already generated and a WS isn't active yet
    // For Code, we need the WS to send the code back after generation.

    if (type === 'qr') {
        // If a WS connection is established, it will call startBaileys.
        // If not, this HTTP response can return the QR if available or prompt WS connection.
        if (pairingData.qr) {
             res.json({ qr: pairingData.qr });
        } else {
            // Prompt client to connect via WebSocket to get the QR
            // The actual startBaileys for QR will be triggered by the WS connection message
            res.json({ message: "Connect via WebSocket to receive QR code." });
        }
    } else if (type === 'code') {
        // For pairing code, the phone number is essential.
        // The actual startBaileys for code will be triggered by the WS connection message
        // that includes the phone number.
        res.json({ message: "Connect via WebSocket and send phone number to generate pairing code." });
    } else {
        res.status(400).json({ error: 'Invalid pairing type specified.' });
    }
});

wss.on('connection', (ws) => {
    console.log('Frontend client connected via WebSocket.');
    clientWs = ws; // Store the active client WebSocket

    // Send current status if a pairing process was already underway
    if (pairingData.status === 'qr' && pairingData.qr) {
        ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
    } else if (pairingData.status === 'code_requested' && pairingData.pairingCode) {
        ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
    } else if (pairingData.status === 'connecting') {
        ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Server is initializing WhatsApp connection...' }));
    } else if (pairingData.status === 'connected') {
         ws.send(JSON.stringify({
            event: 'pairingSuccess',
            message: `Already paired. Session ID: ${pairingData.sessionId}`,
            sessionId: pairingData.sessionId,
            phoneNumber: pairingData.userPhoneNumber
        }));
    }


    ws.on('message', async (message) => {
        console.log('Received message from client:', message.toString());
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'requestQr') {
                pairingData.userPhoneNumber = data.phoneNumber; // Store phone number for confirmation later
                console.log(`QR request from client. User phone for confirmation: ${pairingData.userPhoneNumber}`);
                if (sock && pairingData.status === 'qr' && pairingData.qr) {
                    ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'qr')) {
                    await startBaileys('qr');
                } else {
                     ws.send(JSON.stringify({ event: 'statusUpdate', message: 'QR generation already in progress or socket busy.' }));
                }
            } else if (data.type === 'requestCode') {
                const userPhoneNumberForCode = data.phoneNumber;
                if (!userPhoneNumberForCode || !/^\d+$/.test(userPhoneNumberForCode)) {
                    ws.send(JSON.stringify({ event: 'errorMessage', message: 'Valid phone number is required to generate pairing code.' }));
                    return;
                }
                pairingData.userPhoneNumber = userPhoneNumberForCode; // Store for confirmation
                console.log(`Pairing code request from client for ${userPhoneNumberForCode}.`);
                 if (sock && pairingData.status === 'code_requested' && pairingData.pairingCode) {
                    ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'code_requested')) {
                    await startBaileys('code', userPhoneNumberForCode);
                } else {
                    ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Pairing code generation already in progress or socket busy.' }));
                }
            }
        } catch (e) {
            console.error('Error processing message from client:', e);
            ws.send(JSON.stringify({ event: 'errorMessage', message: 'Invalid message format.' }));
        }
    });

    ws.on('close', () => {
        console.log('Frontend client disconnected WebSocket.');
        if (ws === clientWs) {
            clientWs = null; // Clear the stored client WebSocket
            // Optionally, you might want to stop Baileys if the client disconnects
            // and no pairing is active or if you want to enforce a single client.
            // if (sock && pairingData.status !== 'connected') {
            //     console.log("Client disconnected, stopping Baileys pairing attempt.");
            //     sock.logout(); // or sock.end(...)
            //     sock = null;
            //     pairingData = { status: 'disconnected' };
            // }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error with client:', error);
         if (ws === clientWs) {
            clientWs = null;
        }
    });
});

// Serve index.html for the root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/qr', (req, res) => { // Changed from /qr.html to /qr
    res.sendFile(path.join(__dirname, 'qr.html'));
});
app.get('/pairing-code', (req, res) => { // Changed from /pairing_code.html to /pairing-code
    res.sendFile(path.join(__dirname, 'pairing_code.html'));
});


server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server established on ws://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
    console.log("Shutting down server...");
    if (sock) {
        try {
            // await sock.logout(); // Proper logout if connected
            console.log("Baileys socket closed.");
        } catch (e) {
            console.error("Error during Baileys socket logout:", e);
        }
    }
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});
