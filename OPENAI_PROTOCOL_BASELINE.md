OpenChat Desktop OpenAI protocol baseline

Codex: 0.148.0
Tag: rust-v0.148.0
Commit: 3ba0f71

Transport:
codex app-server over stdio JSONL

Experimental API:
DISABLED

Auth:
account/read
account/login/start type=chatgpt
account/login/start type=chatgptDeviceCode
account/login/cancel
account/logout

Models:
model/list

Threads:
thread/start
thread/resume
thread/delete

System Prompt:
ThreadStartParams.developerInstructions

Turns:
turn/start
turn/interrupt

Streaming:
turn/started
item/started
item/agentMessage/delta
item/completed
turn/completed
error

Generated schemas:
./vendor/openai/codex-0.148.0/schema-ts
./vendor/openai/codex-0.148.0/schema-json

DO NOT UPDATE WITHOUT PROTOCOL MIGRATION.