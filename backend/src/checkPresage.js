// Presage sanity check:  npm run check:presage
import { config } from './config.js';

const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
console.log(`Node ${process.version} on ${process.platform}-${process.arch}${glibc ? `, glibc ${glibc}` : ''}`);
if (glibc && Number(glibc.split('.')[1]) < 35 && glibc.startsWith('2.')) {
  console.log(`✗ Presage needs glibc 2.35+. This machine has ${glibc}.`);
  console.log('  In a Codespace: pull the latest main, then Command Palette -> "Codespaces: Rebuild Container".');
}
if (!config.presageKey) console.log('✗ PRESAGE_API_KEY is empty in backend/.env');
else console.log(`✓ Key loaded (ends in ...${config.presageKey.slice(-4)})`);

try {
  const sdk = await import('@smartspectra/node-sdk');
  console.log(`✓ SDK loaded (version ${sdk.SmartSpectraSDK?.version ?? 'unknown'})`);
} catch (err) {
  console.log('✗ SDK failed to load:', err.message);
  console.log('  Try: npm install   (it is an optional dependency, so a failed download is silent)');
  process.exit(1);
}
try {
  await import('jpeg-js');
  console.log('✓ jpeg-js loaded');
} catch {
  console.log('✗ jpeg-js missing: run npm install');
}
console.log(config.presageKey ? '\nReady. Restart the backend; the setup screen should show "Presage (webcam)".' : '');
