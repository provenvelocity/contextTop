use std::env;
use std::io::{self, BufRead, Write};

use contexttop_core::{Aggregator, recommendations};
use contexttop_protocol::{
    ContextEvent, FixAction, FixResult, IpcEnvelope, IpcMessage, PROTOCOL_VERSION, Recommendation,
};

fn main() -> io::Result<()> {
    let expected_token = env::var("CONTEXTTOP_HANDSHAKE_TOKEN").unwrap_or_default();
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    let Some(first_line) = lines.next() else {
        return Ok(());
    };
    let hello = match parse_envelope(&first_line?) {
        Ok(envelope) => envelope,
        Err(error) => return write_error(&mut stdout, "invalid_message", &error),
    };
    if hello.protocol_version != PROTOCOL_VERSION {
        return write_error(
            &mut stdout,
            "protocol_version_mismatch",
            "unsupported protocol version",
        );
    }
    let IpcMessage::Hello { handshake_token } = hello.message else {
        return write_error(
            &mut stdout,
            "handshake_required",
            "first message must be hello",
        );
    };
    if expected_token.is_empty() || handshake_token != expected_token {
        return write_error(&mut stdout, "unauthorized", "invalid handshake token");
    }

    write_message(
        &mut stdout,
        IpcEnvelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: "hello-ack".into(),
            message: IpcMessage::Hello {
                handshake_token: "accepted".into(),
            },
        },
    )?;

    let mut aggregator = Aggregator::default();
    let mut available_fixes = Vec::new();
    for line in lines {
        let line = line?;
        let envelope = match parse_envelope(&line) {
            Ok(envelope) => envelope,
            Err(error) => {
                write_error(&mut stdout, "invalid_message", &error)?;
                continue;
            }
        };
        if envelope.protocol_version != PROTOCOL_VERSION {
            write_error(
                &mut stdout,
                "protocol_version_mismatch",
                "unsupported protocol version",
            )?;
            continue;
        }
        match envelope.message {
            IpcMessage::Event(event) => {
                available_fixes = emit_bucket(&mut stdout, &mut aggregator, event)?;
            }
            IpcMessage::FixAction { fix_id, action } => {
                emit_fix_result(&mut stdout, &available_fixes, fix_id, action)?;
            }
            IpcMessage::Hello { .. } => write_error(
                &mut stdout,
                "unexpected_hello",
                "handshake already completed",
            )?,
            IpcMessage::Bucket(_)
            | IpcMessage::Recommendations(_)
            | IpcMessage::FixResult(_)
            | IpcMessage::Error { .. } => write_error(
                &mut stdout,
                "invalid_message",
                "engine accepts events after handshake",
            )?,
        }
    }
    Ok(())
}

fn emit_bucket(
    stdout: &mut impl Write,
    aggregator: &mut Aggregator,
    event: ContextEvent,
) -> io::Result<Vec<Recommendation>> {
    let session_id = event.session_id.clone();
    aggregator.record(event);
    let Some(bucket) = aggregator.buckets(&session_id).last().cloned() else {
        return Ok(Vec::new());
    };
    let fixes = recommendations(&bucket);
    let result = fixes.clone();
    write_message(
        stdout,
        IpcEnvelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: format!("bucket-{}", bucket.window_start_ms),
            message: IpcMessage::Bucket(bucket.clone()),
        },
    )
    .and_then(|_| {
        write_message(
            stdout,
            IpcEnvelope {
                protocol_version: PROTOCOL_VERSION,
                message_id: format!("recommendations-{}", bucket.window_start_ms),
                message: IpcMessage::Recommendations(fixes),
            },
        )
    })?;
    Ok(result)
}

fn emit_fix_result(
    stdout: &mut impl Write,
    available_fixes: &[Recommendation],
    fix_id: String,
    action: FixAction,
) -> io::Result<()> {
    let Some(fix) = available_fixes.iter().find(|fix| fix.id == fix_id) else {
        return write_error(
            stdout,
            "unknown_fix",
            "recommendation is no longer available",
        );
    };
    let (accepted, advisory, message) = match action {
        FixAction::Preview => (
            true,
            fix.disposition != contexttop_protocol::FixDisposition::Supported,
            format!("Preview ready for {}", fix.title),
        ),
        FixAction::Apply => (
            false,
            true,
            format!(
                "{} remains advisory because no supported mutation API is available",
                fix.title
            ),
        ),
    };
    write_message(
        stdout,
        IpcEnvelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: format!("fix-result-{}", fix.id),
            message: IpcMessage::FixResult(FixResult {
                fix_id,
                action,
                accepted,
                advisory,
                message,
            }),
        },
    )
}

fn parse_envelope(line: &str) -> Result<IpcEnvelope, String> {
    serde_json::from_str(line).map_err(|error| error.to_string())
}

fn write_message(stdout: &mut impl Write, envelope: IpcEnvelope) -> io::Result<()> {
    serde_json::to_writer(&mut *stdout, &envelope).map_err(io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn write_error(stdout: &mut impl Write, code: &str, message: &str) -> io::Result<()> {
    write_message(
        stdout,
        IpcEnvelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: "error".into(),
            message: IpcMessage::Error {
                code: code.into(),
                message: message.into(),
            },
        },
    )
}
