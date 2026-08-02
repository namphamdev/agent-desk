//! comet-proto — wire types shared by engine, UI, and RPC.
//!
//! Ported from comet's `packages/control/src/wire.ts` + `packages/harness/src/types.ts`.
//! Token-usage *display* types are excluded by design; the `Usage` agent event is kept as a
//! harness-level passthrough (rate-limit meters), never persisted into docs.

pub mod acp;
pub mod agent;
pub mod entities;
pub mod harness;
pub mod motion;
pub mod providers;
pub mod view;

pub use acp::*;
pub use agent::*;
pub use entities::*;
pub use harness::*;
pub use providers::*;
