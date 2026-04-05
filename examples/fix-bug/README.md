# Fix Bug Example

This example contains a few obvious bugs so users can watch JackCode reason about correctness fixes.

## Files

- `src/buggy.ts`
- `jackcode-task.json`

## Known issues

- `calculateTotal()` ignores item quantity
- `formatUserName()` can crash when `lastName` is missing
- `getFirstCharacter()` returns the second character and crashes on empty strings

## Suggested command

```bash
node dist/cli/index.js --model qwen-3.6 --execute "Fix examples/fix-bug/src/buggy.ts and explain which bugs were corrected."
```

## What a good fix looks like

A good fix should:

- multiply price by quantity
- handle optional names safely
- return the actual first character
- validate empty input where needed
