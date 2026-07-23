#!/usr/bin/env node

import fs from 'node:fs';

const requiredPrograms = [
  'legacy_exec', 'legacy_exit', 'legacy_connect', 'legacy_setuid',
  'legacy_ptrace', 'legacy_bind', 'legacy_openat', 'legacy_unlinkat',
];
const requiredMaps = [
  'EVENTS', 'EXIT_EVENTS', 'CONNECT_EVENTS', 'FILE_EVENTS', 'SEC_EVENTS',
  'EXEC_SCRATCH', 'EXIT_SCRATCH', 'CONNECT_SCRATCH', 'FILE_SCRATCH',
  'SEC_SCRATCH', 'DROPS',
];
const requiredKernelVersion = 0x0004135a;

function fail(message) {
  throw new Error(message);
}

function number(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`ELF value at ${offset} is too large`);
  return Number(value);
}

function slice(buffer, offset, size, label) {
  if (offset < 0 || size < 0 || offset + size > buffer.length) {
    fail(`${label} exceeds object bounds`);
  }
  return buffer.subarray(offset, offset + size);
}

function cstring(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) fail(`string offset ${offset} is invalid`);
  const end = buffer.indexOf(0, offset);
  if (end === -1) fail(`unterminated string at offset ${offset}`);
  return buffer.toString('utf8', offset, end);
}

export function validateLegacyBpfObject(buffer) {
  if (buffer.length < 64 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail('not an ELF object');
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) fail('expected ELF64 little-endian object');
  if (buffer.readUInt16LE(16) !== 1) fail('expected relocatable ELF object');
  if (buffer.readUInt16LE(18) !== 247) fail('expected EM_BPF object');

  const sectionOffset = number(buffer, 40);
  const sectionEntrySize = buffer.readUInt16LE(58);
  const sectionCount = buffer.readUInt16LE(60);
  const sectionNamesIndex = buffer.readUInt16LE(62);
  if (sectionEntrySize < 64 || sectionCount === 0 || sectionNamesIndex >= sectionCount) {
    fail('invalid ELF section table');
  }
  slice(buffer, sectionOffset, sectionEntrySize * sectionCount, 'section table');

  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionOffset + index * sectionEntrySize;
    sections.push({
      index,
      nameOffset: buffer.readUInt32LE(header),
      type: buffer.readUInt32LE(header + 4),
      flags: number(buffer, header + 8),
      offset: number(buffer, header + 24),
      size: number(buffer, header + 32),
      link: buffer.readUInt32LE(header + 40),
      entrySize: number(buffer, header + 56),
    });
  }
  const namesSection = sections[sectionNamesIndex];
  const names = slice(buffer, namesSection.offset, namesSection.size, 'section string table');
  sections.forEach((section) => {
    section.name = cstring(names, section.nameOffset);
    section.data = slice(buffer, section.offset, section.size, `section ${section.name || section.index}`);
  });

  for (const section of sections) {
    if (section.name === '.BTF' || section.name === '.BTF.ext') {
      fail(`forbidden BTF section ${section.name}`);
    }
    if ((section.flags & 0x4) === 0 || section.size === 0) continue;
    if (section.size % 8 !== 0) fail(`executable section ${section.name} is not instruction-aligned`);
    for (let offset = 0; offset < section.size; offset += 8) {
      const code = section.data.readUInt8(offset);
      const instructionClass = code & 0x07;
      const operation = code & 0xf0;
      if (instructionClass === 0x06) {
        fail(`JMP32 instruction unavailable on Linux 4.19 in section ${section.name} at instruction ${offset / 8}`);
      }
      if (instructionClass === 0x05
          && operation !== 0x80 && operation !== 0x90
          && section.data.readInt16LE(offset + 2) < 0) {
        fail(`backward jump in section ${section.name} at instruction ${offset / 8}`);
      }
    }
  }

  const versionSection = sections.find((section) => section.name === 'version');
  if (!versionSection || versionSection.size !== 4) {
    fail('missing required kernel version section for UOS 4.19.90');
  }
  const kernelVersion = versionSection.data.readUInt32LE(0);
  if (kernelVersion !== requiredKernelVersion) {
    const expected = `0x${requiredKernelVersion.toString(16).padStart(8, '0')}`;
    const actual = `0x${kernelVersion.toString(16).padStart(8, '0')}`;
    fail(`expected ${expected} (4.19.90), found ${actual}`);
  }

  const symbols = new Map();
  for (const section of sections.filter((candidate) => candidate.type === 2)) {
    if (section.link >= sections.length || section.entrySize < 24 || section.size % section.entrySize !== 0) {
      fail(`invalid symbol table ${section.name}`);
    }
    const symbolNames = sections[section.link].data;
    for (let offset = 0; offset < section.size; offset += section.entrySize) {
      const name = cstring(symbolNames, section.data.readUInt32LE(offset));
      const targetIndex = section.data.readUInt16LE(offset + 6);
      if (name) symbols.set(name, sections[targetIndex]?.name || '');
    }
  }
  for (const program of requiredPrograms) {
    if (!symbols.has(program)) fail(`missing required symbol ${program}`);
    const section = sections.find((candidate) => candidate.name === symbols.get(program));
    if (!section || (section.flags & 0x4) === 0) fail(`program ${program} is not executable`);
  }
  for (const map of requiredMaps) {
    if (!symbols.has(map)) fail(`missing required symbol ${map}`);
    if (symbols.get(map) !== 'maps') fail(`map ${map} is not in the maps section`);
  }
  return {
    sections: sectionCount,
    symbols: symbols.size,
    bytes: buffer.length,
    kernelVersion,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const objectPath = process.argv[2];
  if (!objectPath) {
    console.error(`Usage: ${process.argv[1]} <probes-legacy.o>`);
    process.exit(2);
  }
  try {
    const result = validateLegacyBpfObject(fs.readFileSync(objectPath));
    console.log(`Legacy BPF object verification passed: bytes=${result.bytes} sections=${result.sections} symbols=${result.symbols} kernel_version=0x${result.kernelVersion.toString(16).padStart(8, '0')}`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  }
}
