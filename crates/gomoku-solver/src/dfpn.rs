//! Experimental depth-first proof-number traversal using the exact shared search graph.
use super::{Expansion, Kind, Search, SearchStats, INF};
use crate::{cache::ProofCache, certificate::Certificate, rules::Game, tactics::TacticalLimits};
use serde::Serialize;

pub struct Dfpn {
    search: Search,
    visits: usize,
    persistent_hits: usize,
}

pub struct DfpnRun<'a> {
    pub edges: usize,
    pub cache: &'a ProofCache,
}

#[derive(Serialize)]
pub struct DfpnStats {
    #[serde(flatten)]
    pub search: SearchStats,
    pub visits: usize,
    pub persistent_hits: usize,
}

impl Dfpn {
    pub fn new(game: Game, attacks: u16, tactics: Option<TacticalLimits>) -> Result<Self, String> {
        let search = match tactics {
            Some(limits) => Search::with_tactics(game, attacks, limits)?,
            None => Search::new(game, attacks)?,
        };
        Ok(Self {
            search,
            visits: 0,
            persistent_hits: 0,
        })
    }

    pub fn advance(&mut self, edges: usize) -> bool {
        self.advance_with_stop(edges, || false)
    }

    pub fn advance_with_stop(&mut self, edges: usize, mut stop: impl FnMut() -> bool) -> bool {
        Runner {
            search: &mut self.search,
            visits: &mut self.visits,
            remaining: edges,
            stop: &mut stop,
            cache: None,
            persistent_hits: &mut self.persistent_hits,
        }
        .deepen(0, (INF + 1, INF + 1));
        !self.search.finished()
    }

    pub fn advance_cached(&mut self, run: DfpnRun<'_>, mut stop: impl FnMut() -> bool) -> bool {
        Runner {
            search: &mut self.search,
            visits: &mut self.visits,
            remaining: run.edges,
            stop: &mut stop,
            cache: Some(run.cache),
            persistent_hits: &mut self.persistent_hits,
        }
        .deepen(0, (INF + 1, INF + 1));
        !self.search.finished()
    }

    pub fn stats(&self) -> DfpnStats {
        DfpnStats {
            search: self.search.stats(),
            visits: self.visits,
            persistent_hits: self.persistent_hits,
        }
    }
    pub fn certificate(&self) -> Result<Option<Certificate>, String> {
        self.search.certificate()
    }

    pub fn save_proofs(&self, cache: &mut ProofCache) -> usize {
        let mut saved = 0;
        for (id, node) in self.search.arena.iter().enumerate() {
            if node.pn != 0 || !matches!(node.kind, Kind::Or) || cache.contains(&node.board) {
                continue;
            }
            let mut nodes = Vec::new();
            let root = self
                .search
                .emit(id, &mut nodes, &mut std::collections::BTreeMap::new());
            saved += usize::from(cache.remember(&node.board, (&nodes, root)));
        }
        saved
    }
}

struct Runner<'a> {
    search: &'a mut Search,
    visits: &'a mut usize,
    remaining: usize,
    stop: &'a mut dyn FnMut() -> bool,
    cache: Option<&'a ProofCache>,
    persistent_hits: &'a mut usize,
}

enum Selection {
    Expand(Expansion),
    Child { id: usize, second: u64 },
}

impl Runner<'_> {
    fn deepen(&mut self, id: usize, (phi, delta): (u64, u64)) {
        *self.visits += 1;
        self.seed(id);
        loop {
            let node = &self.search.arena[id];
            if self.remaining == 0
                || (self.stop)()
                || node.pn == 0
                || node.dn == 0
                || node.pn >= phi
                || node.dn >= delta
            {
                return;
            }
            let Some(selection) = self.select(id) else {
                return;
            };
            match selection {
                Selection::Expand(step) => {
                    self.search.expand(&step);
                    if let Some(&(_, child)) = self.search.arena[step.node].edges.last() {
                        self.seed(child);
                    }
                    self.search.steps.push(step);
                    self.remaining -= 1;
                }
                Selection::Child { id: child, second } => {
                    let bounds = self.thresholds(id, (child, second), (phi, delta));
                    self.deepen(child, bounds);
                }
            }
        }
    }

    fn seed(&mut self, id: usize) {
        let node = &self.search.arena[id];
        if node.pn == 0 || !matches!(node.kind, Kind::Or) {
            return;
        }
        let Some(proof) = self.cache.and_then(|cache| cache.lookup(&node.board)) else {
            return;
        };
        self.search.arena[id].witness = Some((proof.root, proof.nodes));
        self.search.arena[id].pending.clear();
        self.search.propagate(id);
        *self.persistent_hits += 1;
    }

    fn select(&self, id: usize) -> Option<Selection> {
        let node = &self.search.arena[id];
        let metric = |child: usize| match node.kind {
            Kind::Or => self.search.arena[child].pn,
            _ => self.search.arena[child].dn,
        };
        let mut choices: Vec<_> = node
            .edges
            .iter()
            .map(|&(_, child)| (metric(child), Some(child)))
            .collect();
        choices.extend(std::iter::repeat_n((1, None), node.pending.len().min(2)));
        choices.sort_by_key(|&(metric, _)| metric);
        let &(_, child) = choices.first()?;
        let second = choices.get(1).map_or(INF, |&(metric, _)| metric);
        match child {
            Some(id) => Some(Selection::Child { id, second }),
            None => Some(Selection::Expand(Expansion {
                node: id,
                at: *node.pending.last()?,
            })),
        }
    }

    fn thresholds(
        &self,
        parent: usize,
        (child, second): (usize, u64),
        (phi, delta): (u64, u64),
    ) -> (u64, u64) {
        let node = &self.search.arena[parent];
        let child = &self.search.arena[child];
        match node.kind {
            Kind::Or => (
                phi.min(second + 1),
                (delta - node.dn).saturating_add(child.dn).min(INF + 1),
            ),
            _ => (
                (phi - node.pn).saturating_add(child.pn).min(INF + 1),
                delta.min(second + 1),
            ),
        }
    }
}
