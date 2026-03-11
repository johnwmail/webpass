import * as openpgp from 'openpgp';

/** Generate new ECC Curve25519 keypair with passphrase */
export async function generateKeyPair(passphrase: string): Promise<{
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'WebPass User' }],
    passphrase,
    format: 'armored',
  });

  const pubKeyObj = await openpgp.readKey({ armoredKey: publicKey });
  const fingerprint = pubKeyObj.getFingerprint().toUpperCase();

  return { publicKey, privateKey, fingerprint };
}

/** Read fingerprint from armored public key */
export async function getFingerprint(armoredPublicKey: string): Promise<string> {
  const key = await openpgp.readKey({ armoredKey: armoredPublicKey });
  return key.getFingerprint().toUpperCase();
}

/** Decrypt private key with passphrase */
export async function decryptPrivateKey(
  armoredKey: string,
  passphrase: string
): Promise<openpgp.PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey });
  return openpgp.decryptKey({ privateKey, passphrase });
}

/** Encrypt text with public key → armored PGP message */
export async function encryptText(
  text: string,
  publicKeyArmored: string
): Promise<string> {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.createMessage({ text });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
    format: 'armored',
  });
  return encrypted as string;
}

/** Decrypt armored PGP message with decrypted private key */
export async function decryptMessage(
  encrypted: string | Uint8Array,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  if (typeof encrypted === 'string') {
    const message = await openpgp.readMessage({ armoredMessage: encrypted });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
    });
    return data as string;
  } else {
    const message = await openpgp.readMessage({ binaryMessage: encrypted });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
      format: 'utf8',
    });
    return data as string;
  }
}

/** Encrypt text with public key → Uint8Array (binary) */
export async function encryptBinary(
  text: string,
  publicKeyArmored: string
): Promise<Uint8Array> {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.createMessage({ text });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
    format: 'binary',
  });
  return encrypted as Uint8Array;
}

/** Decrypt binary PGP message */
export async function decryptBinary(
  encrypted: Uint8Array,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  const message = await openpgp.readMessage({ binaryMessage: encrypted });
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
  });
  return data as string;
}

/** Encrypt text with a recipient's public key (for encrypt tool) */
export async function encryptForRecipient(
  text: string,
  recipientPublicKeyArmored: string
): Promise<string> {
  return encryptText(text, recipientPublicKeyArmored);
}
