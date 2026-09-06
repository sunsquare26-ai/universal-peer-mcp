import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const library = dlopen("/usr/lib/libSystem.B.dylib", {
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __error: { args: [], returns: FFIType.ptr }
});

export function localPeerPid(socket) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw new Error("UDS file descriptor unavailable");
  const pid = new Int32Array(1); const length = new Uint32Array([4]);
  if (library.symbols.getsockopt(fd, 0, 0x002, ptr(pid), ptr(length)) !== 0) {
    const errno = new Int32Array(toArrayBuffer(library.symbols.__error(), 0, 4))[0];
    throw new Error(`LOCAL_PEERPID failed (${errno})`);
  }
  if (length[0] !== 4 || pid[0] <= 1) throw new Error("LOCAL_PEERPID returned invalid data");
  return pid[0];
}
