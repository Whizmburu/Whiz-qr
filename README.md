My apologies for the confusion regarding the error logs. I understand now that the useInMemoryAuthState error was an example.

We are still facing the TypeError: makeInMemoryStore is not a function at line 60 of WHIZ-MD/index.js. My tools have been unable to correctly modify this line.

Please manually edit WHIZ-MD/index.js as follows:

Near the top (around lines 23-32), find the require('@whiskeysockets/baileys') statement and remove or comment out makeInMemoryStore from the list of destructured functions.
Go to line 60 (approximately), which should be const store = makeInMemoryStore({ ... });. Replace this entire block of code (about 5-6 lines) with:
let store = undefined;
// console.warn("makeInMemoryStore call has been bypassed as it was causing a TypeError. Store-dependent features might be affected.");
After these manual changes, please try npm start again. If the TypeError is resolved, I will then provide the code to enable pairing multiple numbers without restarting. If a new error occurs, please share it.
