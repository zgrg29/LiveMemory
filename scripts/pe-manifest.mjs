/**
 * Minimal PE resource manifest reader/patcher for the Windows EXE build.
 *
 * Windows reads the RT_MANIFEST resource to decide the UAC level. Node's
 * official node.exe contains an asInvoker manifest; the build replaces that
 * text with requireAdministrator and updates the resource data-entry size.
 * The new manifest must fit in the existing .rsrc padding (it does for the
 * official x64 node.exe); the build fails rather than corrupting the binary.
 */

function peSections(buffer) {
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('latin1', pe, pe + 4) !== 'PE\u0000\u0000') {
    throw new Error('not a PE file');
  }
  const coff = pe + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unknown PE optional-header magic ${magic}`);
  const dataDirectory = optional + (magic === 0x20b ? 112 : 96);
  const resourceRva = buffer.readUInt32LE(dataDirectory + 2 * 8);
  const resourceSize = buffer.readUInt32LE(dataDirectory + 2 * 8 + 4);
  const sections = [];
  const table = optional + optionalSize;
  for (let i = 0; i < sectionCount; i += 1) {
    const entry = table + i * 40;
    sections.push({
      name: buffer.toString('latin1', entry, entry + 8).replace(/\0+$/, ''),
      virtualSize: buffer.readUInt32LE(entry + 8),
      virtualAddress: buffer.readUInt32LE(entry + 12),
      rawSize: buffer.readUInt32LE(entry + 16),
      rawPointer: buffer.readUInt32LE(entry + 20)
    });
  }
  return {resourceRva, resourceSize, sections};
}

function rvaToOffset(pe, rva) {
  for (const section of pe.sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + section.virtualSize) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside every PE section`);
}

function resourceEntries(buffer, pe, directoryRva) {
  const base = rvaToOffset(pe, directoryRva);
  const named = buffer.readUInt16LE(base + 12);
  const ids = buffer.readUInt16LE(base + 14);
  const entries = [];
  for (let i = 0; i < named + ids; i += 1) {
    const entry = base + 16 + i * 8;
    const name = buffer.readUInt32LE(entry);
    const child = buffer.readUInt32LE(entry + 4);
    entries.push({
      name: name & 0x7fffffff,
      isString: Boolean(name & 0x80000000),
      child: child & 0x7fffffff,
      isDirectory: Boolean(child & 0x80000000)
    });
  }
  return entries;
}

/** @returns {{text:string,dataOffset:number,dataEntryOffset:number,capacity:number,sectionEnd:number}} */
export function readManifest(buffer) {
  const pe = peSections(buffer);
  if (!pe.resourceRva) throw new Error('PE has no resource directory');
  const root = resourceEntries(buffer, pe, pe.resourceRva);
  const type = root.find((entry) => !entry.isString && entry.name === 24);
  if (!type) throw new Error('PE has no RT_MANIFEST (24) resource');
  const names = resourceEntries(buffer, pe, pe.resourceRva + type.child);
  if (names.length === 0 || !names[0].isDirectory) throw new Error('manifest resource has no name entry');
  const languages = resourceEntries(buffer, pe, pe.resourceRva + names[0].child);
  const language = languages.find((entry) => !entry.isDirectory);
  if (!language) throw new Error('manifest resource has no language entry');
  const dataEntryOffset = rvaToOffset(pe, pe.resourceRva) + language.child;
  const dataRva = buffer.readUInt32LE(dataEntryOffset);
  const size = buffer.readUInt32LE(dataEntryOffset + 4);
  const dataOffset = rvaToOffset(pe, dataRva);
  const section = pe.sections.find((item) => (
    dataRva >= item.virtualAddress && dataRva < item.virtualAddress + item.virtualSize
  ));
  if (!section) throw new Error('manifest data is outside every section');
  const sectionEnd = section.rawPointer + section.rawSize;
  return {
    text: buffer.toString('utf8', dataOffset, dataOffset + size).replace(/^\uFEFF/, ''),
    dataOffset,
    dataEntryOffset,
    size,
    capacity: sectionEnd - dataOffset,
    sectionEnd
  };
}

/**
 * Replace the requestedExecutionLevel and write the manifest back in place.
 * @returns {string} the new manifest text
 */
export function setManifestLevel(buffer, level) {
  if (!['asInvoker', 'highestAvailable', 'requireAdministrator'].includes(level)) {
    throw new Error(`unsupported manifest level ${level}`);
  }
  const manifest = readManifest(buffer);
  if (!/level="(?:asInvoker|highestAvailable|requireAdministrator)"/.test(manifest.text)) {
    throw new Error('manifest has no requestedExecutionLevel level attribute');
  }
  const text = manifest.text.replace(
    /level="(?:asInvoker|highestAvailable|requireAdministrator)"/,
    `level="${level}"`
  );
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > manifest.capacity) {
    throw new Error(`new manifest (${bytes.length} bytes) does not fit in resource padding (${manifest.capacity})`);
  }
  bytes.copy(buffer, manifest.dataOffset);
  buffer.writeUInt32LE(bytes.length, manifest.dataEntryOffset + 4);
  return text;
}

export function manifestLevel(buffer) {
  const text = readManifest(buffer).text;
  const match = /level="(asInvoker|highestAvailable|requireAdministrator)"/.exec(text);
  return match ? match[1] : null;
}

export const __internal = {peSections, rvaToOffset, resourceEntries};
