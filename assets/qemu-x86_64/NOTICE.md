# Bundled QEMU x86_64 user-mode runtime

This directory is a generic fallback for S2 plugins that ship a `linux-x64`
native worker but no AArch64 build. `qemu-x86_64` executes the x86_64 worker in
the DSHM Alpine guest; the `rootfs/` directory supplies the glibc loader and
libraries the worker links against.

- `qemu-x86_64`: Alpine 3.22 `qemu-x86_64` 10.0.0-r1 (aarch64 build), GPL-2.0.
  Source: https://pkgs.alpinelinux.org/package/v3.22/community/aarch64/qemu-x86_64
- `rootfs/lib64/ld-linux-x86-64.so.2`,
  `rootfs/lib/x86_64-linux-gnu/libc.so.6`,
  `rootfs/lib/x86_64-linux-gnu/libgcc_s.so.1`: Ubuntu 24.04 x86_64 base rootfs,
  LGPL-2.1/GPL-2.0 with GCC runtime exception.
  Source: https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/

The fallback is optional: when a plugin has a native AArch64 worker, the generic
S2 adapter stages that directly and these files are not used.
