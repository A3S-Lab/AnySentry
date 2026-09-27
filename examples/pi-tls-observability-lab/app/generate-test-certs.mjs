import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function runOpenSsl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function certificateStillValid(certificatePath) {
  try {
    await readFile(certificatePath);
  } catch {
    return false;
  }
  const result = spawnSync('openssl', ['x509', '-checkend', '3600', '-noout', '-in', certificatePath]);
  return result.status === 0;
}

export async function ensureTestCertificates(directory) {
  const tlsDirectory = path.resolve(directory);
  const files = {
    caCert: path.join(tlsDirectory, 'ca.crt'),
    caKey: path.join(tlsDirectory, 'ca.key'),
    serverCert: path.join(tlsDirectory, 'server.crt'),
    serverKey: path.join(tlsDirectory, 'server.key'),
  };
  await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
  if (await certificateStillValid(files.serverCert) && await certificateStillValid(files.caCert)) {
    return files;
  }

  const csrPath = path.join(tlsDirectory, 'server.csr');
  const extensionPath = path.join(tlsDirectory, 'server.ext');
  await writeFile(extensionPath, [
    'subjectAltName=DNS:fake-llm,DNS:localhost,IP:127.0.0.1',
    'extendedKeyUsage=serverAuth',
    'keyUsage=digitalSignature,keyEncipherment',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  runOpenSsl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', '2', '-subj', '/CN=AnySentry Pi Lab Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
    '-keyout', files.caKey, '-out', files.caCert,
  ]);
  runOpenSsl([
    'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-subj', '/CN=fake-llm', '-keyout', files.serverKey, '-out', csrPath,
  ]);
  runOpenSsl([
    'x509', '-req', '-sha256', '-days', '2',
    '-in', csrPath, '-CA', files.caCert, '-CAkey', files.caKey,
    '-CAcreateserial', '-extfile', extensionPath, '-out', files.serverCert,
  ]);

  await chmod(files.caCert, 0o644);
  await chmod(files.serverCert, 0o644);
  await chmod(files.caKey, 0o600);
  await chmod(files.serverKey, 0o600);
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2] || process.env.FIXTURE_TLS_DIR;
  if (!directory) throw new Error('certificate directory argument is required');
  await ensureTestCertificates(directory);
}
