#[cfg(test)]
mod tt_bucket_tests {
    use super::*;

    #[test]
    fn tt_buckets_collisions_overwrite_mates_and_last_bucket() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        unsafe {
            reset_context(false, 0, 0, false);
            // Adding a multiple of 2^20 preserves the starting bucket.
            let hashes = [0_u32, 1 << 20, 2 << 20, 3 << 20, 4 << 20];
            for (index, depth) in [8, 3, 11, 6].into_iter().enumerate() {
                tt_store(hashes[index], 100 + index as u32, depth, 2, 50, EXACT, 1);
                assert_eq!(tt_lookup(hashes[index]), tt_entry(index));
            }
            assert!(tt_lookup(hashes[4]).is_null(), "a full-bucket miss must stop");
            tt_store(hashes[4], 104, 9, 2, MATE - 7, LOWER, 7);
            assert!(tt_lookup(hashes[1]).is_null(), "replace the shallowest slot");
            assert_eq!(tt_lookup(hashes[4]), tt_entry(1));
            assert_eq!((*tt_lookup(hashes[4])).score, MATE - 5);
            assert_eq!(context().tt_count, 4);
            assert!(!context().tt_saturated);

            // A 32-bit-key collision replaces rather than hides a second h2.
            tt_store(hashes[4], 999, 1, 3, -MATE + 8, UPPER, 9);
            let replaced = tt_lookup(hashes[4]);
            assert_eq!((*replaced).h2, 999);
            assert_eq!((*replaced).score, -MATE + 5);
            assert_eq!((*replaced).depth, 1);
            assert_eq!((*replaced).flag, UPPER);
            assert_eq!((*replaced).mv, 9);
            assert_eq!(context().tt_count, 4);
            assert_eq!((0..4).filter(|&i| (*tt_entry(i)).h1 == hashes[4]).count(), 1);

            // Find a key in the last bucket; every last slot stays in bounds.
            let last_hash = (0_u32..TT_CAPACITY as u32)
                .find(|&key| tt_start_index(key) == TT_CAPACITY - TT_BUCKET_SIZE)
                .unwrap();
            for i in 0..4 {
                let key = last_hash + ((i as u32) << 20);
                tt_store(key, i as u32 + 200, i as i32 + 1, 0, 17, EXACT, 1);
                assert_eq!(tt_lookup(key), tt_entry(TT_CAPACITY - TT_BUCKET_SIZE + i));
            }
            tt_store(last_hash + (4 << 20), 204, 2, 0, 18, EXACT, 1);
            assert!(tt_lookup(last_hash).is_null());
            assert_eq!(context().tt_count, 8);
        }
    }

    #[test]
    fn tt_buckets_generation_full_occupancy_and_budget() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        unsafe {
            reset_context(false, 1, 0, false);
            tt_store(12, 13, 4, 0, 20, EXACT, 1);
            assert!(!tt_lookup(12).is_null());
            reset_context(false, 1, 0, false);
            assert!(tt_lookup(12).is_null());
            assert_eq!(context().tt_count, 0);

            // Every bucket gets four distinct h1 identities: multiplication by
            // an odd number permutes the low 20 bits of these keys.
            for h1 in 0..TT_CAPACITY as u32 {
                tt_store(h1, h1 ^ 0x12345678, 1, 0, 23, EXACT, 1);
            }
            assert_eq!(context().tt_count, TT_CAPACITY);
            assert!(!context().tt_saturated);
            assert!(check_budget(), "a full TT must not abort a legal next node");
            assert!(!check_budget(), "the independent node budget still applies");
            assert_eq!(context().abort_reason, StopReason::NodeLimit);
            tt_store(TT_CAPACITY as u32, 7, 2, 0, 29, LOWER, 3);
            assert_eq!(context().tt_count, TT_CAPACITY);
            assert!(!tt_lookup(TT_CAPACITY as u32).is_null());
            assert_eq!((*tt_entry(0)).h1, TT_CAPACITY as u32,
                "equal-depth victims use the first slot deterministically");

            TT_GENERATION = u16::MAX;
            (*tt_entry(tt_start_index(12))).generation = 1;
            reset_context(false, 0, 0, false);
            assert_eq!(TT_GENERATION, 1);
            assert!(tt_lookup(12).is_null(), "wrapped generations must clear stale slots");
            assert_eq!(context().tt_count, 0);
        }
    }

    #[test]
    fn tt_buckets_search_rejects_wrong_second_hash() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        unsafe {
            clear_game_history();
            let mut position = engine::parse_fen(b"k7/8/8/8/8/8/4R3/4K3 w - - 4 1").unwrap();
            let expected = run_fixed(&mut position, 1, 0, false).score;
            reset_context(false, 0, 0, true);
            let hash = hash_position(&mut position);
            tt_store(hash.h1, hash.h2 ^ 1, 1, 0, 123456, EXACT, 1);
            assert_ne!((*tt_lookup(hash.h1)).h2, hash.h2);
            let result = search_node(&mut position, 1, -SCORE_INF, SCORE_INF, 0);
            assert_ne!(result, 123456, "an h1 collision must not authorize an exact score");
            assert_eq!(result, expected);
        }
    }
}
