const express = require('express');
const path = require('path');
const qrcode = require('qrcode'); // For generating QR code image data URL
const मेकWASocket = require('@whiskeysockets/baileys').default;
const { Browsers, useMultiFileAuthState } = require('@whiskeysockets/baileys'); // Changed import

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null; // In-memory store for the QR code string
let sock = null; // Baileys socket instance
let waConnectionState = 'closed'; // Track connection state

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

async function connectToWhatsApp() {
    if (sock) { // If a socket exists, try to close it first
        try {
            await sock.logout();
        } catch (e) {
            console.log("Error logging out previous session, might already be closed:", e);
        }
        sock = null;
    }
    currentQR = null; // Reset QR on new connection attempt
    waConnectionState = 'connecting';

    // Using useMultiFileAuthState as it's the documented method
    // For a QR-only generator, the actual file persistence might not be critical
    // if the server restarts frequently, but Baileys expects this structure.
    // A directory 'baileys_auth_info' will be created if it doesn't exist.
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = मेकWASocket({
        auth: state,
        printQRInTerminal: false, // We handle QR display on the webpage
        browser: Browsers.macOS('Desktop'), // Simulate a desktop browser for stability
        logger: require('pino')({ level: 'silent' }) // Can be 'info' for debugging
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            console.log('QR code received from Baileys.');
            currentQR = qr;
            waConnectionState = 'qr_received';
        }
        if (connection === 'close') {
            waConnectionState = 'closed';
            currentQR = null;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401); // 401 means unrecoverable auth error (e.g. logged out elsewhere)
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting: ', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000); // Wait 5s before reconnecting
            } else {
                console.log("Not reconnecting due to unrecoverable auth error.");
            }
        } else if (connection === 'open') {
            waConnectionState = 'open';
            currentQR = null; // QR is no longer needed
            console.log('WhatsApp connection opened.');

            // Logic for sending automated messages upon successful pairing
            if (sock && sock.user && sock.user.id) {
                const userJid = sock.user.id;
                console.log(`User ${userJid} connected. Generating session ID and sending messages.`);

                // 1. Generate unique session ID
                const secureToken = require('crypto').randomBytes(16).toString('hex');
                const sessionId = `WHIZMD_${secureToken}`;

                // 2. Send automated WhatsApp messages
                try {
                    // Message 1: Session ID
                    await sock.sendMessage(userJid, { text: sessionId });
                    console.log(`Sent session ID to ${userJid}: ${sessionId}`);

                    // Message 2: Confirmation reply
                    const confirmationMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔════════════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected & Running
╚════════════════════════════╝
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254754783683`;
                    await sock.sendMessage(userJid, { text: confirmationMessage });
                    console.log(`Sent confirmation message to ${userJid}`);

                } catch (error) {
                    console.error(`Failed to send automated messages to ${userJid}:`, error);
                }
            } else {
                console.error("Connection opened, but sock.user.id is not available to send messages.");
            }
        }
    });

    sock.ev.on('creds.update', saveCreds); // Save creds for in-memory auth

    // We don't need 'messages.upsert' for QR scan confirmation,
    // 'connection.update' with 'open' status and sock.user.id is the primary indicator.
}

// API endpoint for the frontend to fetch the QR code
app.get('/api/get-qr-code', async (req, res) => {
    if (waConnectionState === 'connecting' && !currentQR) {
        return res.status(202).json({ status: 'connecting', message: 'Connecting to WhatsApp, please wait...' });
    }
    if (currentQR) {
        try {
            const qrDataURL = await qrcode.toDataURL(currentQR, { errorCorrectionLevel: 'H', width: 250 });
            // The WHIZ-MD logo embedding will be handled client-side via CSS overlay for simplicity
            // as directly embedding in QR via node-qrcode can be complex for dynamic QRs.
            return res.json({ status: 'success', qrDataURL: qrDataURL });
        } catch (err) {
            console.error('Failed to generate QR code image:', err);
            return res.status(500).json({ status: 'error', message: 'Failed to generate QR code image.' });
        }
    } else if (waConnectionState === 'open') {
        return res.json({ status: 'connected', message: 'Already connected to WhatsApp. No QR code needed.' });
    } else {
        // If no QR and not open, it might be an error or initial connection phase
        return res.status(202).json({ status: 'pending', message: 'Waiting for QR code from WhatsApp. Please refresh shortly.' });
    }
});

// Endpoint to serve the QR code page
app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/', (req, res) => {
    res.send('WHIZ-MD QR Generator. Visit <a href="/qr">/qr</a> to get your QR code.');
});


app.listen(PORT, () => {
    console.log(`WHIZ-MD QR Generator server running on http://localhost:${PORT}`);
    connectToWhatsApp().catch(err => {
        console.error("Initial connection to WhatsApp failed:", err);
        // Potentially retry or provide a status that the service is down
    });
});
