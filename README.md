# pump-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/farras45/pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/farras45/pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper bot that plays the pump.fun replay sprint by scalping launches in their first few slots. It steps in only while a fresh curve still trades near its opening price, then gets out at the first sign the trade has gone wrong — or right.

## How it trades

- **Buy the open, not the pump:** a coin is eligible for at most 20 slots after creation, with 1–5 distinct buyers besides the creator, no creator sale yet, at least 1 SOL of real reserves behind it, and a price still sitting between −5% and +10% of where it opened.
- **Small and capped:** 0.02 SOL per coin, no more than 5 positions open at once, and exits are always decided before new entries so a sale can free a slot in the same batch.
- **Out fast, either way:** the whole position goes at +10% profit or −10% loss, or after 500 slots stuck below cost. A coin that has been bought is never bought again — fresh coins are what keep the count up.
- **Nothing left to chance:** every order follows from the harness state alone. No clock, no environment, no random numbers, so the same replay always gives the same orders.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=5pr0457j&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
