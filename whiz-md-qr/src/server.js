const express = require('express');
const path = require('path');
const qrcode = require('qrcode'); // For generating QR code image data URL
const fs = require('fs').promises; // For directory removal
const crypto = require('crypto');
const मेकWASocket = require('@whiskeysockets/baileys').default;
const { Browsers, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for temporary QR sessions and active user sessions
// For QR sessions: keyed by tempId, stores { qr, status, socket, authPath, creationTime }
// For active user sessions (Phase 2): keyed by JID, stores { socket, authPath }
const qrSessions = new Map();
const activeSessions = new Map(); // For later use with persistent sessions

const TEMP_AUTH_SESSIONS_DIR = 'baileys_temp_qr_sessions';
const PERMANENT_AUTH_SESSIONS_DIR = 'baileys_auth_info'; // For persistent user sessions

// Ensure temporary directory exists
fs.mkdir(TEMP_AUTH_SESSIONS_DIR, { recursive: true }).catch(console.error);
fs.mkdir(PERMANENT_AUTH_SESSIONS_DIR, { recursive: true }).catch(console.error);

const STALE_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_QR_SESSION_AGE_MS = 2 * 60 * 1000; // Consider QR session stale after 2 minutes for cleanup if not opened

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

async function cleanupSession(sessionId, authPath, socketInstance, removeFromQrSessionsMap = true) {
    console.log(`Cleaning up session: ${sessionId} at path: ${authPath}`);
    if (socketInstance) {
        try {
            await socketInstance.logout();
        } catch (e) {
            console.error(`Error logging out socket for session ${sessionId}:`, e.message);
        }
    }
    if (authPath) {
        try {
            await fs.rm(authPath, { recursive: true, force: true });
            console.log(`Removed auth directory: ${authPath}`);
        } catch (e) {
            console.error(`Error removing auth directory ${authPath}:`, e.message);
        }
    }
    if (removeFromQrSessionsMap) {
        qrSessions.delete(sessionId);
    }
}

async function cleanupOldOrphanedSessions() {
    console.log('Running cleanup for old/orphaned temporary sessions...');
    try {
        const sessionDirs = await fs.readdir(TEMP_AUTH_SESSIONS_DIR);
        for (const dirName of sessionDirs) {
            const sessionId = dirName; // If dirName is the sessionId directly (e.g. qr_xxxx)
                                       // Or parse if like session_qr_xxxx
            const sessionAuthPath = path.join(TEMP_AUTH_SESSIONS_DIR, dirName);
            let shouldDelete = false;

            const sessionData = qrSessions.get(sessionId);
            if (sessionData) {
                // Check age even if in map, in case of stale entries
                if (Date.now() - sessionData.creationTime > MAX_QR_SESSION_AGE_MS * 2 && sessionData.status !== 'open') {
                    console.log(`Session ${sessionId} is in map but very old and not open. Marking for cleanup.`);
                    shouldDelete = true;
                }
            } else {
                // Not in active qrSessions map, check directory age
                try {
                    const stats = await fs.stat(sessionAuthPath);
                    if (Date.now() - stats.mtimeMs > STALE_SESSION_CLEANUP_INTERVAL_MS / 2) { // Example: 30 mins for non-map entries
                         console.log(`Session directory ${dirName} is old and not in active map. Marking for cleanup.`);
                        shouldDelete = true;
                    }
                } catch (statError) {
                    console.error(`Error stating directory ${sessionAuthPath}, possibly already deleted:`, statError.message);
                    shouldDelete = true; // If we can't stat it, might as well try to clean up entry if any or assume it's gone
                }
            }

            if (shouldDelete) {
                console.log(`Proceeding with cleanup for orphaned/stale session: ${sessionId}`);
                await cleanupSession(sessionId, sessionAuthPath, sessionData ? sessionData.socket : null, true);
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${TEMP_AUTH_SESSIONS_DIR} does not exist, no cleanup needed yet.`);
        } else {
            console.error('Error during cleanup of old sessions:', error);
        }
    }
}


// Function to initiate a WhatsApp connection for a given session ID and auth path
// This will be used for temporary QR generation sessions initially
async function initiateWhatsAppConnection(sessionId, authPath, isTemporaryQrSession = true) {
    console.log(`Initiating WhatsApp connection for session: ${sessionId}, path: ${authPath}`);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const socket = मेकWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['𝐰𝐡𝐢𝐳 𝐦𝐝', 'Chrome', '4.0.0'],
        logger: require('pino')({ level: 'silent' })
    });

    qrSessions.set(sessionId, {
        qr: null,
        status: 'connecting',
        socket: socket, // Store the socket instance
        authPath: authPath,
        userJid: null,
        whizMdSessionId: null,
        creationTime: Date.now()
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        const sessionData = qrSessions.get(sessionId);

        if (!sessionData) {
            console.warn(`No session data found for ${sessionId} during connection update. Socket might have been cleaned up.`);
            if (socket) await socket.logout().catch(e => console.error("Error logging out orphaned socket:", e));
            return;
        }

        if (qr) {
            console.log(`QR code received for session ${sessionId}`);
            sessionData.qr = qr;
            sessionData.status = 'qr_received';
        }

        if (connection === 'close') {
            console.log(`Connection closed for session ${sessionId}. Error:`, lastDisconnect?.error?.message);
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            // If it's a temporary QR session that didn't open, or if it's an unrecoverable error for it
            if (isTemporaryQrSession && (sessionData.status !== 'open' || statusCode === DisconnectReason.loggedOut || statusCode === 401)) {
                console.log(`Cleaning up temporary QR session ${sessionId} due to close before open or auth error.`);
                await cleanupSession(sessionId, authPath, socket);
            }
            // For persistent sessions (Phase 2), more sophisticated reconnection would be here.
            // For now, temporary sessions are just cleaned up if they close without success.
        } else if (connection === 'open') {
            console.log(`WhatsApp connection opened for session ${sessionId}. User: ${socket.user?.id}`);
            sessionData.status = 'open';
            sessionData.userJid = socket.user?.id;

            if (isTemporaryQrSession && socket.user?.id) {
                const userJid = socket.user.id;
                const whizSecureToken = crypto.randomBytes(16).toString('hex');
                const whizMdSessionId = `WHIZMD_${whizSecureToken}`;
                sessionData.whizMdSessionId = whizMdSessionId; // Store for the status API

                try {
                    await socket.sendMessage(userJid, { text: whizMdSessionId });
                    console.log(`Sent session ID to ${userJid} for session ${sessionId}`);
                    const confirmationMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔════════════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected & Running
╚════════════════════════════╝
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254783683683`; // Corrected number
                    await socket.sendMessage(userJid, { text: confirmationMessage });
                    console.log(`Sent confirmation message to ${userJid} for session ${sessionId}`);
                } catch (error) {
                    console.error(`Failed to send automated messages for session ${sessionId}:`, error);
                }
                // Don't immediately clean up; let the status poll confirm, then it can be cleaned.
                // Or, transition to a persistent session here in Phase 2.
                // For Phase 1, we'll rely on a timeout or the status endpoint to trigger cleanup.
            }
        }
    });
    return socket; // Return the socket for immediate use if needed by caller
}


// API endpoint for the frontend to fetch a new QR code
app.get('/api/get-qr-code', async (req, res) => {
    const tempSessionId = `qr_${crypto.randomBytes(8).toString('hex')}`;
    const tempAuthPath = path.join(TEMP_AUTH_SESSIONS_DIR, tempSessionId);

    try {
        console.log(`Request for new QR. Generating temporary session ID: ${tempSessionId} at path: ${tempAuthPath}`);
        // Ensure the specific auth path directory exists for this new temporary session
        await fs.mkdir(tempAuthPath, { recursive: true });

        // Initiate a new Baileys connection for this QR request.
        // This function now populates qrSessions internally.
        initiateWhatsAppConnection(tempSessionId, tempAuthPath, true);

        // Wait for the QR code to be available from the Baileys instance, with a timeout.
        let attempts = 0;
        const maxAttempts = 20; // Wait up to 20 seconds for QR
        const pollInterval = 1000; // Check every 1 second

        const intervalId = setInterval(async () => {
            attempts++;
            const sessionData = qrSessions.get(tempSessionId);

            if (sessionData && sessionData.qr) {
                clearInterval(intervalId);
                try {
                    const qrDataURL = await qrcode.toDataURL(sessionData.qr, { errorCorrectionLevel: 'H', width: 250 });
                    console.log(`QR generated for session ${tempSessionId}, sending to client.`);
                    // Set a timeout to clean up this QR session if not scanned
                    setTimeout(() => {
                        const currentSession = qrSessions.get(tempSessionId);
                        if (currentSession && currentSession.status !== 'open' && currentSession.status !== 'scanned_success_reported') {
                            console.log(`QR session ${tempSessionId} timed out (60s) before being confirmed as scanned by client, cleaning up.`);
                            // Note: 'scanned_success_reported' would be a new status if we want to differentiate
                            await cleanupSession(tempSessionId, currentSession.authPath, currentSession.socket);
                        }
                    }, QR_VALIDITY_SECONDS * 1000 + 5000); // Cleanup slightly after QR validity if not scanned and confirmed

                    res.json({ status: 'success', qrDataURL: qrDataURL, tempSessionId: tempSessionId });
                } catch (err) {
                    console.error(`Failed to generate QR code image for session ${tempSessionId}:`, err);
                    await cleanupSession(tempSessionId, tempAuthPath, sessionData.socket); // Use await
                    if (!res.headersSent) {
                        res.status(500).json({ status: 'error', message: 'Failed to generate QR image.' });
                    }
                }
            } else if (sessionData && (sessionData.status === 'closed' || sessionData.status === 'error')) {
                clearInterval(intervalId);
                console.error(`Connection closed or errored while waiting for QR for session ${tempSessionId}.`);
                await cleanupSession(tempSessionId, tempAuthPath, sessionData.socket);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'Failed to get QR from WhatsApp (connection closed/error).' });
                }
            } else if (attempts > maxAttempts) {
                clearInterval(intervalId);
                console.error(`Timeout waiting for QR for session ${tempSessionId}.`);
                const existingSessionData = qrSessions.get(tempSessionId); // Re-fetch, might have changed
                await cleanupSession(tempSessionId, tempAuthPath, existingSessionData ? existingSessionData.socket : null); // Use await
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'Timeout waiting for QR code from WhatsApp.' });
                }
            }
        }, pollInterval);

    } catch (error) {
        console.error(`Critical error in /api/get-qr-code for session ${tempSessionId}:`, error);
        // Attempt cleanup even if qrSessions entry wasn't fully made
        const finalCheckSessionData = qrSessions.get(tempSessionId); // Re-fetch before final cleanup attempt
        await cleanupSession(tempSessionId, tempAuthPath, finalCheckSessionData ? finalCheckSessionData.socket : null); // Use await
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: 'Server error initiating QR session.' });
        }
    }
});

// API endpoint for the frontend to poll QR scan status
app.get('/api/qr-status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionData = qrSessions.get(sessionId);

    if (!sessionData) {
        return res.status(404).json({ status: 'error', message: 'Session not found or expired.' });
    }

    if (sessionData.status === 'open' && sessionData.userJid && sessionData.whizMdSessionId) {
        console.log(`Scan success reported for session ${sessionId}. User: ${sessionData.userJid}. WHIZ-MD ID: ${sessionData.whizMdSessionId}`);
        // Respond with success and the WHIZ-MD session ID
        res.json({
            status: 'scanned_success',
            message: 'Successfully paired!',
            whizMdSessionId: sessionData.whizMdSessionId,
            userJid: sessionData.userJid
        });
        // Clean up this temporary QR session after reporting success
        // Delay slightly to ensure client receives response before cleanup affects socket
                    // No longer cleaning up here directly, rely on QR timeout in /api/get-qr-code
                    // or a periodic stale session cleaner if this endpoint is hit after cleanup.
                    // The sessionData.socket might be null if already cleaned.
                    // setTimeout(() => {
                    //     cleanupSession(sessionId, sessionData.authPath, sessionData.socket);
                    // }, 2000);
                    sessionData.status = 'scanned_success_reported'; // Mark that client acknowledged
                });
    } else if (sessionData.status === 'qr_received') {
        res.json({ status: 'pending_scan', message: 'QR code generated, waiting for scan.' });
    } else if (sessionData.status === 'connecting') {
        res.json({ status: 'connecting', message: 'Baileys instance is still connecting to get QR.' });
    } else if (sessionData.status === 'closed' || sessionData.status === 'error' || sessionData.status === 'scanned_success_reported') {
        // If it closed, errored, or already reported success and potentially cleaned up
        console.log(`Session ${sessionId} is in a terminal state (${sessionData.status}) for this poll.`);
        res.status(410).json({ status: 'expired_or_closed', message: 'QR session is no longer valid or already processed.' });
        // Ensure cleanup if it's just closed/errored and not yet reported as success
        if (sessionData.status !== 'scanned_success_reported') {
           await cleanupSession(sessionId, sessionData.authPath, sessionData.socket);
        }
    } else {
        console.warn(`Unknown session status for ${sessionId}: ${sessionData.status}`);
        res.status(500).json({ status: 'unknown', message: 'Unknown session state.' });
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
    // Initial cleanup and start periodic cleanup
    cleanupOldOrphanedSessions().then(() => {
        setInterval(cleanupOldOrphanedSessions, STALE_SESSION_CLEANUP_INTERVAL_MS);
    });
});
