import { options } from 'preact';

let lastSetMFor = '';
let mSetAt = 0;

const origR = (options as any).__r;
(options as any).__r = function (vnode: any) {
  const name = vnode && vnode.type && (vnode.type.name || String(vnode.type).substring(0, 30));
  console.log('[DIAG:__r] called for', name);
  lastSetMFor = name || '(null)';
  mSetAt = Date.now();
  const r = origR ? origR.call(this, vnode) : undefined;
  return r;
};

const origD = (options as any).diffed;
(options as any).diffed = function (vnode: any) {
  if (vnode && vnode.type && (vnode.type.name === 'Welcome' || String(vnode.type).includes('onSetup'))) {
    console.log('[DIAG:diffed] Welcome');
  }
  return origD ? origD.call(this, vnode) : undefined;
};

const origB = (options as any).__b;
(options as any).__b = function (vnode: any) {
  if (vnode && vnode.type && (vnode.type.name === 'Welcome' || String(vnode.type).includes('onSetup'))) {
    console.log('[DIAG:__b] Welcome');
  }
  return origB ? origB.call(this, vnode) : undefined;
};

const origH = (options as any).__h;
(options as any).__h = function (m: any, hookIndex: number, type: number) {
  if (m === null || m === undefined) {
    console.error('[DIAG:__h] m = null!');
    console.error('[DIAG] typeof options.__r:', typeof (options as any).__r);
    console.error('[DIAG] Last __r was for:', lastSetMFor, 'at', mSetAt);
    // Instead of throwing, create a dummy currentComponent to prevent Preact crash
    console.error('[DIAG] Returning dummy component to prevent crash');
    // @ts-ignore - prevent the crash by returning early
    return undefined;
  }
  return origH ? origH(m, hookIndex, type) : undefined;
};
