/**
 * 掃碼輸入。掃碼槍為主（鍵盤 + Enter），鏡頭為備援。
 * @param {{input:HTMLInputElement, onScan:(code:string)=>void,
 *          cameraButton?:HTMLButtonElement, video?:HTMLVideoElement}} opts
 */
function createScanInput({ input, onScan, cameraButton, video }) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    input.value = '';
    onScan(code);
  });

  // 掃碼槍是模擬鍵盤的，輸入框失焦就掃不進去。點到頁面空白處後把焦點搶回來，
  // 但使用者正在填其他欄位時不能動它。
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest && t.closest('input, select, textarea, button, a, .omni-item, .omni-panel')) return;
    input.focus();
  });

  // 鏡頭備援：失敗一律靜默退回掃碼槍，不可跳錯誤中斷作業。
  if (cameraButton && video) {
    cameraButton.addEventListener('click', async () => {
      if (!('BarcodeDetector' in window)) {
        showToast('這個瀏覽器不支援鏡頭掃碼，請用掃碼槍', 'error');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        video.srcObject = stream;
        video.hidden = false;
        await video.play();
        const detector = new BarcodeDetector({ formats: ['ean_13', 'code_39', 'code_128'] });
        const stop = () => {
          stream.getTracks().forEach((tr) => tr.stop());
          video.hidden = true;
        };
        const tick = async () => {
          if (video.hidden) return;
          try {
            const found = await detector.detect(video);
            if (found.length) { stop(); onScan(found[0].rawValue); return; }
          } catch { /* 單張辨識失敗就繼續下一張 */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => {
          if (!video.hidden) { stop(); showToast('鏡頭沒掃到，請改用掃碼槍'); }
        }, 30000);
      } catch {
        showToast('無法開啟鏡頭，請用掃碼槍', 'error');
      }
    });
  }

  input.focus();
  return { focus: () => input.focus() };
}
