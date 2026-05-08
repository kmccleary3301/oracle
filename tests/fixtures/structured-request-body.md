# Oracle Composer Newline Preservation Probe

Please review this request as if it were pasted directly into the ChatGPT composer.

## Required checks

1. Preserve every markdown heading and blank line.
2. Preserve indentation inside code fences.
3. Preserve nested JSON objects that use four-space indentation.
4. Do not collapse list spacing or paragraph breaks.

## Structured payload

```json
{
    "request_id": "oracle-newline-preservation-probe",
    "metadata": {
        "source": "codex-live-composer-test",
        "priority": "high",
        "tags": [
            "browser",
            "composer",
            "newlines",
            "indentation"
        ]
    },
    "instructions": {
        "summary": "Validate that text bodies survive insertion into the ChatGPT composer.",
        "constraints": {
            "preserve_newlines": true,
            "preserve_indentation": true,
            "submit_request": false
        },
        "steps": [
            {
                "index": 1,
                "action": "insert",
                "expected": "body appears exactly as provided"
            },
            {
                "index": 2,
                "action": "read_back",
                "expected": "readback equals original body"
            }
        ]
    }
}
```

## Final note

The composer should contain this final paragraph on its own line, with the blank
line above preserved.
