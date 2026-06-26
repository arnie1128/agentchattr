//! MCP injection + identity proxy.
//!
//! `inject` writes the per-agent MCP config (file / env / launch flags) so the
//! agent CLI connects to the agentchattr MCP server with the right auth.
//! `proxy` is the local identity proxy used by codex (`proxy_flag` mode).

pub mod inject;
pub mod proxy;
