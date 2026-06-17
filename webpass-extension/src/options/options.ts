const we = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

const privateKeyEl = document.getElementById('privateKey') as HTMLTextAreaElement;
const serverUrlEl = document.getElementById('serverUrl') as HTMLInputElement;
const fingerprintEl = document.getElementById('fingerprint') as HTMLInputElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;

// Load saved values
we.storage.local.get(['privateKeyArmored', 'serverUrl', 'fingerprint']).then((state: any) => {
  if (state.privateKeyArmored) privateKeyEl.value = state.privateKeyArmored;
  if (state.serverUrl) serverUrlEl.value = state.serverUrl;
  if (state.fingerprint) fingerprintEl.value = state.fingerprint;
});

saveBtn.addEventListener('click', async () => {
  await we.storage.local.set({
    privateKeyArmored: privateKeyEl.value.trim(),
    serverUrl: serverUrlEl.value.trim(),
    fingerprint: fingerprintEl.value.trim().toUpperCase(),
  });
  statusEl.style.display = 'block';
  setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
});
