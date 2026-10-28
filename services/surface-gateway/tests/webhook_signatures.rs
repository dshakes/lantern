//! Black-box signature negatives: boots the real binary and POSTs to the real
//! routes. Verification runs before dispatch, so none of these need Redis or a
//! control plane (the positive cases use payloads that yield no events).

use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use sha2::Sha256;

const TG_SECRET: &str = "tg-secret-token";
const WA_APP_SECRET: &str = "wa-app-secret";

struct Gateway {
    child: Child,
    base: String,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn boot() -> Gateway {
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_lantern-surface-gateway"))
        .env("LISTEN_ADDR", format!("127.0.0.1:{port}"))
        .env("TELEGRAM_BOT_TOKEN", "123:fake")
        .env("TELEGRAM_SECRET_TOKEN", TG_SECRET)
        .env("WHATSAPP_VERIFY_TOKEN", "verify")
        .env("WHATSAPP_API_TOKEN", "wa-token")
        .env("WHATSAPP_PHONE_NUMBER_ID", "555")
        .env("WHATSAPP_APP_SECRET", WA_APP_SECRET)
        .env_remove("LANTERN_ENV")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn surface-gateway");
    let gw = Gateway {
        child,
        base: format!("http://127.0.0.1:{port}"),
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(r) = reqwest::get(format!("{}/healthz", gw.base)).await
            && r.status().is_success()
        {
            return gw;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("surface-gateway did not become healthy");
}

fn wa_sig(body: &[u8], secret: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

async fn post(
    gw: &Gateway,
    path: &str,
    headers: &[(&str, String)],
    body: &'static str,
) -> reqwest::StatusCode {
    let mut req = reqwest::Client::new()
        .post(format!("{}{path}", gw.base))
        .header("content-type", "application/json")
        .body(body);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    req.send().await.unwrap().status()
}

const TG_BODY: &str = r#"{"update_id":1}"#;
const WA_BODY: &str = r#"{"object":"whatsapp_business_account","entry":[]}"#;

#[tokio::test]
async fn telegram_secret_token_is_enforced() {
    let gw = boot().await;
    let p = "/webhooks/telegram";

    assert_eq!(post(&gw, p, &[], TG_BODY).await, 401, "missing header");
    let wrong = [("x-telegram-bot-api-secret-token", "nope".to_string())];
    assert_eq!(post(&gw, p, &wrong, TG_BODY).await, 401, "wrong token");
    // Same length as the real secret, so a length-only check would pass it.
    let same_len = [(
        "x-telegram-bot-api-secret-token",
        "x".repeat(TG_SECRET.len()),
    )];
    assert_eq!(
        post(&gw, p, &same_len, TG_BODY).await,
        401,
        "same-length wrong token"
    );

    let ok = [("x-telegram-bot-api-secret-token", TG_SECRET.to_string())];
    assert_eq!(post(&gw, p, &ok, TG_BODY).await, 200, "correct token");
}

#[tokio::test]
async fn whatsapp_hub_signature_is_enforced() {
    let gw = boot().await;
    let p = "/webhooks/whatsapp";

    assert_eq!(post(&gw, p, &[], WA_BODY).await, 401, "missing signature");
    let bad = [(
        "x-hub-signature-256",
        wa_sig(WA_BODY.as_bytes(), "wrong-secret"),
    )];
    assert_eq!(
        post(&gw, p, &bad, WA_BODY).await,
        401,
        "signed with wrong secret"
    );
    let no_prefix = [("x-hub-signature-256", "deadbeef".to_string())];
    assert_eq!(
        post(&gw, p, &no_prefix, WA_BODY).await,
        401,
        "malformed header"
    );
    // Valid signature for a DIFFERENT body must not verify this one.
    let other = [("x-hub-signature-256", wa_sig(b"{}", WA_APP_SECRET))];
    assert_eq!(
        post(&gw, p, &other, WA_BODY).await,
        401,
        "signature of another body"
    );

    let ok = [(
        "x-hub-signature-256",
        wa_sig(WA_BODY.as_bytes(), WA_APP_SECRET),
    )];
    assert_eq!(post(&gw, p, &ok, WA_BODY).await, 200, "correct signature");
}

#[tokio::test]
async fn telegram_fixture_base_url_is_refused_in_production() {
    let out = Command::new(env!("CARGO_BIN_EXE_lantern-surface-gateway"))
        .env("LISTEN_ADDR", format!("127.0.0.1:{}", free_port()))
        .env("LANTERN_ENV", "production")
        .env("TELEGRAM_BOT_TOKEN", "123:fake")
        .env("TELEGRAM_SECRET_TOKEN", TG_SECRET)
        .env("TELEGRAM_API_BASE_URL", "http://127.0.0.1:9")
        .output()
        .unwrap();
    assert!(!out.status.success(), "prod must refuse to start");
    assert!(String::from_utf8_lossy(&out.stderr).contains("TELEGRAM_API_BASE_URL"));
}
