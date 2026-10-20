#!/usr/bin/env python3
"""Downgrade the hypot symbol version requirement from GLIBC_2.35 to GLIBC_2.2.5.

The published @a3s-lab/code-linux-x64-gnu 8.6.0 addon references hypot@GLIBC_2.35
(the only 2.35 symbol). glibc's hypot(double,double) has existed unchanged since
GLIBC_2.2.5; the 2.35 entry is an artifact of the build machine's newer glibc.
The Rocky 9 debug machine provides glibc 2.34, so retarget:

  1. .gnu.version[hypot] index 14 (GLIBC_2.35) -> 8 (GLIBC_2.2.5)
  2. the libm GLIBC_2.35 Vernaux hash/name -> GLIBC_2.2.5 (leaves a harmless
     duplicate 2.2.5 requirement; loader finds it in any glibc >= 2.2.5)

Usage: patch_hypot.py <input.so> <output.so> [--verify-only]
"""
import struct
import sys


def elf_hash(name: str) -> int:
    h = 0
    for b in name.encode():
        h = (h << 4) + b
        g = h & 0xF0000000
        if g:
            h ^= g >> 24
        h &= ~g
    return h & 0xFFFFFFFF


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    src_path, dst_path = sys.argv[1], sys.argv[2]
    verify_only = "--verify-only" in sys.argv

    data = bytearray(open(src_path, "rb").read())

    # --- ELF64 header ---
    assert data[:4] == b"\x7fELF" and data[4] == 2 and data[5] == 1, "not ELF64 LE"
    e_shoff, e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<Q", data, 0x28)[0], *struct.unpack_from("<HHH", data, 0x3A)

    def sh(i):
        off = e_shoff + i * e_shentsize
        (name, typ, flags, addr, offset, size, link, info, align, entsize) = struct.unpack_from("<IIQQQQIIQQ", data, off)
        return dict(name=name, typ=typ, offset=offset, size=size, link=link, entsize=entsize)

    shstr = sh(e_shstrndx)
    def cstr(base_off, off):
        end = data.index(b"\0", base_off + off)
        return data[base_off + off:end].decode()

    sections = [sh(i) for i in range(e_shnum)]
    by_name = {}
    for s in sections:
        s["sname"] = cstr(shstr["offset"], s["name"])
        by_name[s["sname"]] = s

    dynsym, dynstr = by_name[".dynsym"], by_name[".dynstr"]
    gnuver, gnuver_r = by_name[".gnu.version"], by_name[".gnu.version_r"]

    # --- find hypot symbol index ---
    hypot_idx = None
    for i in range(dynsym["size"] // dynsym["entsize"]):
        st_name = struct.unpack_from("<I", data, dynsym["offset"] + i * dynsym["entsize"])[0]
        if cstr(dynstr["offset"], st_name) == "hypot":
            hypot_idx = i
    assert hypot_idx is not None, "hypot not found in .dynsym"

    ver_off = gnuver["offset"] + hypot_idx * 2
    hypot_ver = struct.unpack_from("<H", data, ver_off)[0]

    # --- walk .gnu.version_r: find libm Verneed and its vernaux entries ---
    off = gnuver_r["offset"]
    end = gnuver_r["offset"] + gnuver_r["size"]
    target_aux = None
    ref_225 = None
    libm_found = False
    while off < end:
        vn_version, vn_cnt, vn_file, vn_aux, vn_next = struct.unpack_from("<HHIII", data, off)
        fname = cstr(dynstr["offset"], vn_file)
        if fname == "libm.so.6":
            libm_found = True
            aux = off + vn_aux
            for _ in range(vn_cnt):
                vna_hash, vna_flags, vna_other, vna_name, vna_next = struct.unpack_from("<IHHII", data, aux)
                nm = cstr(dynstr["offset"], vna_name)
                if nm == "GLIBC_2.35":
                    target_aux = aux
                if nm == "GLIBC_2.2.5":
                    ref_225 = aux
                if vna_next == 0:
                    break
                aux += vna_next
        if vn_next == 0:
            break
        off += vn_next
    assert libm_found, "libm Verneed not found"

    if verify_only:
        print(f"hypot symbol index={hypot_idx} current version idx={hypot_ver}; "
              f"GLIBC_2.35 aux={'present' if target_aux else 'absent'}; "
              f"GLIBC_2.2.5 aux={'present' if ref_225 else 'absent'}")
        return

    assert target_aux is not None, "no GLIBC_2.35 vernaux to patch (already patched?)"
    assert ref_225 is not None, "no GLIBC_2.2.5 vernaux to retarget to"

    # 2.2.5 aux fields (hash + name offset) to clone onto the 2.35 aux
    ref_hash, _, ref_other, ref_name, _ = struct.unpack_from("<IHHII", data, ref_225)
    assert elf_hash("GLIBC_2.2.5") == ref_hash, "hash sanity failed"

    struct.pack_into("<H", data, ver_off, ref_other)            # hypot -> version idx of 2.2.5
    struct.pack_into("<I", data, target_aux + 0, ref_hash)      # vna_hash
    struct.pack_into("<I", data, target_aux + 8, ref_name)      # vna_name (hash/flags/other/name layout)

    open(dst_path, "wb").write(bytes(data))
    print(f"patched: hypot version index {hypot_ver} -> {ref_other}; "
          f"GLIBC_2.35 vernaux retargeted to GLIBC_2.2.5; wrote {dst_path}")


if __name__ == "__main__":
    main()
