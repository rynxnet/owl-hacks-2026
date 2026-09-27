// Plays the interviewer's line. Uses ElevenLabs audio when the backend sent it,
// otherwise the browser's built-in voice so the app still works with no keys.
// rate: browser-voice speed only (ElevenLabs audio already has the persona's speed baked in).
export function playLine(text, audioBase64, rate = 1.05) {
  return new Promise((resolve) => {
    if (audioBase64) {
      const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().catch(resolve);
      return;
    }
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}
