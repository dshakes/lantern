//! Guest-side AF_VSOCK client (broker egress mode, ADR 0026).
//!
//! A broker-mode VM has no NIC: the harness reaches the host only over vsock
//! (CID 2). Firecracker hands a guest `connect(2, port)` to the host Unix socket
//! `<vsock_uds>_<port>`. tokio has no vsock type and the tree has no vsock
//! crate, so this is the minimal non-blocking stream over `libc` + `AsyncFd`.
//! Non-Linux builds (dev hosts) get a stub that always errors.

/// The host's well-known vsock context id.
pub const HOST_CID: u32 = 2;

#[cfg(target_os = "linux")]
mod imp {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::pin::Pin;
    use std::task::{Context, Poll, ready};

    use tokio::io::unix::AsyncFd;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    pub struct VsockStream {
        fd: AsyncFd<OwnedFd>,
    }

    /// Register a socket fd with the reactor.
    fn register(fd: OwnedFd) -> io::Result<AsyncFd<OwnedFd>> {
        // SAFETY: `fd` is a fresh, valid socket fd we exclusively own; it moves
        // into the AsyncFd and stays registered until the AsyncFd drops it.
        Ok(unsafe { AsyncFd::register(fd) }?)
    }

    pub async fn connect(cid: u32, port: u32) -> io::Result<VsockStream> {
        // SAFETY: plain socket(2); the fd is owned immediately below.
        let raw = unsafe {
            libc::socket(
                libc::AF_VSOCK,
                libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                0,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw` is a fresh, valid fd we exclusively own.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        // SAFETY: sockaddr_vm is plain-old-data; zeroed is a valid value.
        let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_cid = cid;
        addr.svm_port = port;
        // SAFETY: `addr` outlives the call; the length matches its type.
        let rc = unsafe {
            libc::connect(
                fd.as_raw_fd(),
                (&addr as *const libc::sockaddr_vm).cast(),
                std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
            )
        };
        let fd = register(fd)?;
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EINPROGRESS) {
                return Err(err);
            }
            // Non-blocking connect: wait for writability, then read SO_ERROR.
            let mut guard = fd.writable().await?;
            guard.clear_ready();
            let mut so_err: libc::c_int = 0;
            let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            // SAFETY: out-pointers are valid for the declared length.
            let rc = unsafe {
                libc::getsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut so_err as *mut libc::c_int).cast(),
                    &mut len,
                )
            };
            if rc < 0 {
                return Err(io::Error::last_os_error());
            }
            if so_err != 0 {
                return Err(io::Error::from_raw_os_error(so_err));
            }
        }
        Ok(VsockStream { fd })
    }

    impl AsyncRead for VsockStream {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            loop {
                let mut guard = ready!(self.fd.poll_read_ready(cx))?;
                let unfilled = buf.initialize_unfilled();
                // SAFETY: reading into an initialized, exclusively borrowed slice.
                let res = guard.try_io(|fd| {
                    let n = unsafe {
                        libc::read(fd.as_raw_fd(), unfilled.as_mut_ptr().cast(), unfilled.len())
                    };
                    if n < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                });
                match res {
                    Ok(Ok(n)) => {
                        buf.advance(n);
                        return Poll::Ready(Ok(()));
                    }
                    Ok(Err(e)) => return Poll::Ready(Err(e)),
                    Err(_would_block) => continue,
                }
            }
        }
    }

    impl AsyncWrite for VsockStream {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            data: &[u8],
        ) -> Poll<io::Result<usize>> {
            loop {
                let mut guard = ready!(self.fd.poll_write_ready(cx))?;
                // SAFETY: writing from a borrowed, initialized slice.
                let res = guard.try_io(|fd| {
                    let n =
                        unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
                    if n < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                });
                match res {
                    Ok(r) => return Poll::Ready(r),
                    Err(_would_block) => continue,
                }
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            // SAFETY: shutdown(2) on an fd we own.
            let rc = unsafe { libc::shutdown(self.fd.as_raw_fd(), libc::SHUT_WR) };
            Poll::Ready(if rc < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            })
        }
    }

    impl tonic::transport::server::Connected for VsockStream {
        type ConnectInfo = ();
        fn connect_info(&self) -> Self::ConnectInfo {}
    }

    /// Listening AF_VSOCK socket (host-initiated connects arrive here).
    pub struct VsockListener {
        fd: AsyncFd<OwnedFd>,
    }

    pub fn listen(port: u32) -> io::Result<VsockListener> {
        // SAFETY: plain socket(2); the fd is owned immediately below.
        let raw = unsafe {
            libc::socket(
                libc::AF_VSOCK,
                libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                0,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw` is a fresh, valid fd we exclusively own.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        // SAFETY: sockaddr_vm is plain-old-data; zeroed is a valid value.
        let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_cid = libc::VMADDR_CID_ANY;
        addr.svm_port = port;
        // SAFETY: `addr` outlives the call; the length matches its type.
        let rc = unsafe {
            libc::bind(
                fd.as_raw_fd(),
                (&addr as *const libc::sockaddr_vm).cast(),
                std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: listen(2) on an fd we own.
        if unsafe { libc::listen(fd.as_raw_fd(), 128) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(VsockListener { fd: register(fd)? })
    }

    impl VsockListener {
        pub async fn accept(&self) -> io::Result<VsockStream> {
            loop {
                let mut guard = self.fd.readable().await?;
                // SAFETY: accept4(2) with null peer-address out-params.
                let res = guard.try_io(|fd| {
                    let c = unsafe {
                        libc::accept4(
                            fd.as_raw_fd(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                        )
                    };
                    if c < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(c)
                    }
                });
                match res {
                    Ok(Ok(c)) => {
                        // SAFETY: accept4 returned a fresh fd we now own.
                        let fd = unsafe { OwnedFd::from_raw_fd(c) };
                        return Ok(VsockStream { fd: register(fd)? });
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(_would_block) => continue,
                }
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    /// Stand-in type so callers compile on dev hosts; never constructed.
    pub type VsockStream = tokio::net::UnixStream;

    pub async fn connect(_cid: u32, _port: u32) -> std::io::Result<VsockStream> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "vsock is only available inside a Linux microVM",
        ))
    }

    /// Stand-in; `listen` always fails off Linux.
    pub struct VsockListener;

    pub fn listen(_port: u32) -> std::io::Result<VsockListener> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "vsock is only available inside a Linux microVM",
        ))
    }

    impl VsockListener {
        pub async fn accept(&self) -> std::io::Result<VsockStream> {
            std::future::pending().await
        }
    }
}

pub use imp::{connect, listen};
