#!/usr/bin/env python3
"""Retarget GLIBC_2.35-only symbol version requirements down to GLIBC_2.2.5.

The published @a3s-lab/code linux-x64-gnu artifacts reference hypot@2.35 and
hypotf@2.35 (build-machine glibc artifacts). glibc has provided hypot/hypotf
with an unchanged ABI since 2.2.5, so on a glibc 2.34 host the version
references are rewritten instead of rebuilding (the 8.6.0 source tree needs
unpublished workspace crates).

Handles: the addon .node and the moli runtime binary.
Usage: patch-code-glibc.py <input> <output>
       patch-code-glibc.py --inplace <file>
"""
import struct
import sys

SYMBOLS = ("hypot", "hypotf")


def elf_hash(name: str) -> int:
    h = 0
    for b in name.encode():
        h = (h << 4) + b
        g = h & 0xF0000000
        if g:
            h ^= g >> 24
        h &= ~g
    return h & 0xFFFFFFFF


def patch(data: bytearray) -> str:
    assert data[:4] == b"\x7fELF" and data[4] == 2 and data[5] == 1, "not ELF64 LE"
    e_shoff = struct.unpack_from("<Q", data, 0x28)[0]
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 0x3A)

    def sh(i):
        off = e_shoff + i * e_shentsize
        vals = struct.unpack_from("<IIQQQQIIQQ", data, off)
        return dict(zip(("name", "typ", "flags", "addr", "offset", "size", "link", "info", "align", "entsize"), vals))

    def cstr(base, off):
        end = data.index(b"\0", base + off)
        return data[base + off:end].decode()

    shstr = sh(e_shstrndx)
    by_name = {}
    for i in range(e_shnum):
        s = sh(i)
        by_name[cstr(shstr["offset"], s["name"])] = s
    dynsym, dynstr = by_name[".dynsym"], by_name[".dynstr"]
    gnuver, gnuver_r = by_name[".gnu.version"], by_name[".gnu.version_r"]

    wanted = {n: None for n in SYMBOLS}
    for i in range(dynsym["size"] // dynsym["entsize"]):
        st_name = struct.unpack_from("<I", data, dynsym["offset"] + i * dynsym["entsize"])[0]
        nm = cstr(dynstr["offset"], st_name)
        if nm in wanted:
            wanted[nm] = i
    missing = [n for n, v in wanted.items() if v is None]
    if missing:
        return f"no {missing} symbols (nothing to patch)"

    off, end = gnuver_r["offset"], gnuver_r["offset"] + gnuver_r["size"]
    aux_235 = aux_225 = None
    while off < end:
        _, vn_cnt, vn_file, vn_aux, vn_next = struct.unpack_from("<HHIII", data, off)
        if cstr(dynstr["offset"], vn_file) == "libm.so.6":
            aux = off + vn_aux
            for _ in range(vn_cnt):
                vna_hash, _, vna_other, vna_name, vna_next = struct.unpack_from("<IHHII", data, aux)
                nm = cstr(dynstr["offset"], vna_name)
                if nm == "GLIBC_2.35":
                    aux_235 = aux
                elif nm == "GLIBC_2.2.5":
                    aux_225 = aux
                if vna_next == 0:
                    break
                aux += vna_next
        if vn_next == 0:
            break
        off += vn_next

    if aux_235 is None:
        return "no GLIBC_2.35 vernaux (already compatible)"
    assert aux_225 is not None, "no GLIBC_2.2.5 vernaux to retarget to"
    ref_hash, _, ref_other, ref_name, _ = struct.unpack_from("<IHHII", data, aux_225)
    assert elf_hash("GLIBC_2.2.5") == ref_hash

    changed = []
    for nm, idx in wanted.items():
        ver_off = gnuver["offset"] + idx * 2
        old = struct.unpack_from("<H", data, ver_off)[0]
        struct.pack_into("<H", data, ver_off, ref_other)
        changed.append(f"{nm} {old}->{ref_other}")
    struct.pack_into("<I", data, aux_235 + 0, ref_hash)
    struct.pack_into("<I", data, aux_235 + 8, ref_name)
    return "patched " + ", ".join(changed) + "; GLIBC_2.35 vernaux -> GLIBC_2.2.5"


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    inplace = "--inplace" in sys.argv
    if inplace:
        (path,) = args
        data = bytearray(open(path, "rb").read())
        print(f"{path}: {patch(data)}")
        open(path, "wb").write(bytes(data))
    else:
        src, dst = args
        data = bytearray(open(src, "rb").read())
        print(f"{src}: {patch(data)}")
        open(dst, "wb").write(bytes(data))


if __name__ == "__main__":
    main()
