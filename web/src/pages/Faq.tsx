const QA: [string, string[]][] = [
  [
    'What does paperfarm do?',
    [
      'Papertrade mints PAPER when a position closes at a loss. paperfarm opens pairs for you: a long and a short of the same size on the same coin. When price moves, one leg loses and mints PAPER while the other wins most of it back. When price has moved your take-profit, both legs close and the next pair opens, until you stop the farm.',
    ],
  ],
  [
    'What does it cost?',
    [
      "paperfarm charges nothing. What you pay is Papertrade's haircut and fee on the winning leg, so each round loses a little in exchange for the PAPER it mints. The order panel shows the cost per 1,000 PAPER before you start, and Stats shows what you have really paid.",
    ],
  ],
  [
    'Where is my money?',
    [
      'In your own Papertrade account, always. paperfarm never holds funds. Deposit and withdraw on papertrade.xyz; paperfarm farms with the balance that is already there.',
    ],
  ],
  [
    'What is the trading key, and what can it do?',
    [
      'paperfarm creates a key for your account, and your wallet approves it on Papertrade for 7 days. paperfarm opens and closes your pairs with it, so farms keep running when the tab is closed.',
      'Papertrade itself limits that key: it can open and close positions, and it can never withdraw, transfer, stake or claim. Staking and claiming are always signed by your own wallet.',
    ],
  ],
  [
    "Do you ever see my wallet's private key?",
    [
      'No. Signing in only asks your wallet to sign a message that proves the address is yours; it cannot move funds. The trading key is a separate key, stored encrypted by paperfarm and never sent anywhere else.',
    ],
  ],
  [
    'What is the worst that could happen?',
    [
      'If paperfarm were compromised, someone could use your trading key to open and close positions, which could lose part of your balance. They could not withdraw it or send it anywhere. Keys expire after 7 days, and you can revoke one from your wallet on Papertrade at any time.',
      'Leverage has its own risk: a leg that reaches its bust price loses its whole margin. Farm only with money you are prepared to lose.',
    ],
  ],
  [
    'How do I stop?',
    [
      'On the Farm page, Pause a farm to open no new pairs while open ones still close at their take-profit, or Stop & close to close its pairs now. Close all exits every pair at once. To cut paperfarm off completely, revoke the trading key from your wallet on Papertrade; that works even if this site is down.',
    ],
  ],
  [
    'What if paperfarm goes down?',
    [
      'Your positions live on Papertrade, so nothing is lost. While it is down, pairs are not closed at their take-profit. You can see and close them on papertrade.xyz, and paperfarm picks up where it left off when it is back.',
    ],
  ],
  [
    'Why is my pair still queued?',
    [
      'Papertrade executes intents through a queue, larger ones first, so an open or close can take a while. An open that has not filled in 5 minutes expires. If only one leg fills, paperfarm closes it (or cancels it while it is still queued) so you are never left unhedged for long.',
    ],
  ],
  [
    'Which speed should I pick?',
    [
      'Steady closes at a bigger move: fewer, cheaper rounds. Fast closes at a smaller move: more PAPER per day at a higher cost per 1,000. Balanced sits in the middle. Fine-tune sets the take-profit, leverage and pairs at a time yourself, and you can change them on a running farm.',
    ],
  ],
  [
    'Is paperfarm affiliated with Papertrade?',
    [
      "No. paperfarm is independent and uses Papertrade's public API, like any other trader. Nothing here is financial advice.",
    ],
  ],
]

export function Faq() {
  return (
    <div className="page faq">
      <div className="pagehead">
        <h1 className="grow">FAQ</h1>
      </div>
      <div className="card">
        {QA.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            {a.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </details>
        ))}
      </div>
    </div>
  )
}
