// Push-to-talk speech recognition using the browser's Web Speech API (works in Chrome and Edge).
// start() begins listening; stop() resolves with the full transcript.
export function createRecognizer(onPartial) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  let finalText = '';
  let resolveStop = null;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    onPartial?.((finalText + interim).trim());
  };
  rec.onend = () => resolveStop?.(finalText.trim());

  return {
    start() {
      finalText = '';
      rec.start();
    },
    stop() {
      return new Promise((resolve) => {
        resolveStop = resolve;
        rec.stop();
      });
    },
  };
}
