//! Stick-to-bottom spring stepper (mugen 1e).

use super::{
    SPRING_CHASE_MAX_LEAD, SPRING_DAMPING, SPRING_GROWTH_EMA, SPRING_MASS, SPRING_STIFFNESS,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct StickSpring {
    pub(super) velocity: f32,
    pub(super) target_vel: f32,
    pub(super) last_target: Option<f32>,
}

impl Default for StickSpring {
    fn default() -> Self {
        Self::new()
    }
}

impl StickSpring {
    pub(super) fn new() -> Self {
        Self {
            velocity: 0.0,
            target_vel: 0.0,
            last_target: None,
        }
    }

    pub(super) fn reset(&mut self) {
        *self = Self::new();
    }

    pub(super) fn is_idle(&self) -> bool {
        self.velocity < 0.05 && self.target_vel < 0.05
    }

    #[cfg(test)]
    pub(crate) fn target_vel(&self) -> f32 {
        self.target_vel
    }

    pub(super) fn step(&mut self, mut pos: f32, target: f32, mut frames: f32) -> f32 {
        let grew = self.last_target.map_or(0.0, |last| target - last);
        self.last_target = Some(target);
        if grew < -1.0 {
            self.target_vel = 0.0;
        } else {
            let observed = grew.max(0.0) / frames.max(0.25);
            self.target_vel += SPRING_GROWTH_EMA * (observed - self.target_vel);
        }
        let chase = target - (self.target_vel * 9.0).min(SPRING_CHASE_MAX_LEAD);
        let mut v = self.velocity;
        while frames > 0.0 {
            let h = frames.min(1.0);
            frames -= h;
            let diff = (chase - pos).max(0.0);
            v += h * ((SPRING_DAMPING * v + SPRING_STIFFNESS * diff) / SPRING_MASS - v);
            pos = (pos + (v + self.target_vel) * h).min(target);
        }
        self.velocity = v;
        if target - pos <= 0.5 { target } else { pos }
    }
}
