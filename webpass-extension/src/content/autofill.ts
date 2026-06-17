// WebPass Content Script
// Detects password fields and enables autofill

const we = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

let passwordFields: HTMLInputElement[] = [];
let webpassBadge: HTMLElement | null = null;
let currentField: HTMLInputElement | null = null;

function findPasswordFields(): HTMLInputElement[] {
  const fields: HTMLInputElement[] = [];
  document.querySelectorAll('input[type="password"]').forEach(el => {
    if (el instanceof HTMLInputElement && el.offsetParent !== null) {
      fields.push(el);
    }
  });
  return fields;
}

function createBadge(field: HTMLInputElement) {
  // Remove existing badge
  removeBadge();

  const badge = document.createElement('div');
  badge.className = 'webpass-fill-badge';
  badge.textContent = '🔑';
  badge.title = 'WebPass Fill';
  badge.style.cssText = `
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    cursor: pointer; font-size: 16px; z-index: 2147483647;
    background: #6366f1; color: white; border-radius: 4px;
    padding: 2px 6px; line-height: 1.4;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    display: none; user-select: none;
  `;

  // Position relative to the field
  const rect = field.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(field);
  if (computedStyle.position === 'static') {
    field.style.position = 'relative';
  }

  field.parentElement?.appendChild(badge);
  webpassBadge = badge;

  // Show badge on focus
  field.addEventListener('focus', () => {
    currentField = field;
    badge.style.display = 'block';
    checkFill();
  });

  field.addEventListener('blur', () => {
    // Hide badge after a short delay to allow click
    setTimeout(() => { badge.style.display = 'none'; }, 300);
  });

  badge.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleFillClick(field);
  });
}

function removeBadge() {
  if (webpassBadge && webpassBadge.parentElement) {
    webpassBadge.parentElement.removeChild(webpassBadge);
  }
  webpassBadge = null;
}

async function checkFill() {
  const hostname = window.location.hostname;
  try {
    const res = await we.runtime.sendMessage({ type: 'CHECK_FILL', hostname });
    if (res && res.entries && res.entries.length > 0 && webpassBadge) {
      webpassBadge.style.display = 'block';
    }
  } catch {
    // Background may not be ready
  }
}

async function handleFillClick(field: HTMLInputElement) {
  const hostname = window.location.hostname;
  try {
    const res = await we.runtime.sendMessage({ type: 'CHECK_FILL', hostname });
    if (!res || !res.entries || res.entries.length === 0) {
      showToast('No matching entries found');
      return;
    }

    // If only one match, try to fill directly
    if (res.entries.length === 1) {
      // Get the SW to send fill data
      const tabId = await getTabId();
      if (tabId) {
        we.runtime.sendMessage({
          type: 'FILL_ON_TAB',
          path: res.entries[0].path,
          tabId,
        });
      }
    } else {
      // Show dropdown with choices (for demo, just use first)
      showToast(`Multiple matches: ${res.entries.map((e: any) => e.path).join(', ')}`);
    }
  } catch (e: any) {
    showToast('WebPass: ' + (e.message || 'Error'));
  }
}

async function getTabId(): Promise<number | undefined> {
  return new Promise(resolve => {
    we.runtime.sendMessage({ type: 'GET_TAB_ID' }, (res: any) => {
      resolve(res?.tabId);
    });
  });
}

function showToast(msg: string) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    background: #1a1a2e; color: #e2e8f0; padding: 10px 16px;
    border-radius: 6px; font-size: 13px; font-family: sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4); max-width: 300px;
    border: 1px solid #334155;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.parentElement.removeChild(toast);
  }, 3000);
}

// ── Listen for fill data from background ────────────────────────────────
we.runtime.onMessage.addListener((req: any, _sender, sendResponse) => {
  if (req.type === 'FILL_ENTRY') {
    // Fill the password field — for demo we just set it on the focused field
    if (currentField) {
      currentField.value = '********'; // Placeholder — real decryption happens in popup
      showToast('Open WebPass popup to decrypt and copy password');
    }
    sendResponse({ success: true });
    return true;
  }
  if (req.type === 'GET_TAB_ID') {
    // This won't work from content script... let's handle differently
    sendResponse({ /* no tabId from here */ });
    return true;
  }
  return true;
});

// ── Initialize ──────────────────────────────────────────────────────────
function init() {
  passwordFields = findPasswordFields();
  passwordFields.forEach(createBadge);
}

// Run on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Observe for dynamically added fields
const observer = new MutationObserver(() => {
  const newFields = findPasswordFields();
  if (newFields.length > passwordFields.length) {
    passwordFields = newFields;
    newFields.forEach(createBadge);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
