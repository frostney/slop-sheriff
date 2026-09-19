# PR43 report failure, 14 September 2026

`review-work-prefix.txt` contains the exact accepted `action.input.appended`
fragments for `review_work`, call `call_TGXG0YA6kpnhMKSGBne0VTmc`, from
child `wrun_41M2FDYYB30GTF2DGQ3F7MBWJ0` on commit `578235f`.

The checkpoint closes without `completedReport`. The next rejected provider
fragment was not retained. Do not fabricate that fragment or claim the parser
rejected otherwise valid JSON. Runtime schema validation also rejects a null
completed report, which the former generated JSON Schema permitted.

The regression replays this prefix through the installed SDK and Gateway
transport with offline responses. This verifies rejection, upstream cancellation
and failure accounting. Valid and invalid operation variants separately exercise
generated schemas, persistence and canonical report assembly. These are contract
and recovery checks, not evidence of real-model review quality.
