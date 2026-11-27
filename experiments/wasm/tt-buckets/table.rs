// Research candidate: four entries per bucket, bounded probes, shallowest
// current-generation victim. The production table size/layout is unchanged.
const TT_BUCKET_SIZE: usize = 4;

#[inline]
fn tt_start_index(h1: u32) -> usize {
    (h1.wrapping_mul(0x9E3779B1) as usize & TT_MASK) & !(TT_BUCKET_SIZE - 1)
}

unsafe fn tt_lookup(h1: u32) -> *mut TTEntry {
    let start = tt_start_index(h1);
    let mut offset = 0;
    while offset < TT_BUCKET_SIZE {
        let entry = tt_entry(start + offset);
        if (*entry).generation != TT_GENERATION {
            return core::ptr::null_mut();
        }
        if (*entry).h1 == h1 {
            return entry;
        }
        offset += 1;
    }
    core::ptr::null_mut()
}

#[inline]
fn tt_unavailable(_count: usize, saturated: bool) -> bool {
    // Occupancy is telemetry, not a stopping condition: a full bucket has a
    // bounded replacement. Keep the reserved error flag for ABI compatibility.
    saturated
}

unsafe fn tt_store(h1: u32, h2: u32, depth: i32, ply: usize, raw_score: i32, flag: u8, mv: u32) {
    let mut score = raw_score;
    if score > MATE_NEAR {
        score += ply as i32;
    } else if score < -MATE_NEAR {
        score -= ply as i32;
    }

    let start = tt_start_index(h1);
    let mut selected = start;
    let mut shallowest = i16::MAX;
    let mut offset = 0;
    while offset < TT_BUCKET_SIZE {
        let index = start + offset;
        let entry = tt_entry(index);
        if (*entry).generation != TT_GENERATION {
            selected = index;
            context().tt_count += 1;
            break;
        }
        // Preserve the baseline's h1-only identity and unconditional overwrite.
        // Callers independently verify h2 before using a hit. Never create two
        // slots with the same h1: lookup must not stop at the wrong h2 sibling.
        if (*entry).h1 == h1 {
            selected = index;
            break;
        }
        if (*entry).depth < shallowest {
            shallowest = (*entry).depth;
            selected = index;
        }
        offset += 1;
    }
    *tt_entry(selected) = TTEntry {
        h1,
        h2,
        score,
        mv,
        depth: depth as i16,
        generation: TT_GENERATION,
        flag,
    };
}

