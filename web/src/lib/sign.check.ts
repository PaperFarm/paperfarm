// node src/lib/sign.check.ts -- the browser signer must reproduce the Go signer's vector byte for byte.
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { signIntent, usdRaw, fromRaw, type Signer, type DomainName } from './paper.ts'

const v = JSON.parse(
  readFileSync(new URL('../../../server/internal/paper/testdata/vector.json', import.meta.url), 'utf8'),
)
const acct = privateKeyToAccount(v.key)
const signer: Signer = { address: acct.address, signTypedData: (td) => acct.signTypedData(td as never) }
let bad = 0
for (const c of v.cases) {
  const { signed, id } = await signIntent(signer, c.Dom as DomainName, c.Primary, v.user, c.Msg)
  const want = JSON.stringify(c.Signed, Object.keys(c.Signed).sort()),
    got = JSON.stringify(signed, Object.keys(signed).sort())
  if (want !== got || id !== c.ID) {
    bad++
    console.error(`✗ ${c.Primary}\n  want ${want} ${c.ID}\n  got  ${got} ${id}`)
  } else console.log(`✓ ${c.Primary}`)
}
if (
  usdRaw(12.34) !== '12340000000000000000' ||
  usdRaw(10.5, 6) !== '10500000' ||
  fromRaw('1265934348411467997435') !== 1265.934348411468 ||
  fromRaw('-5', 0) !== -5
) {
  bad++
  console.error('✗ amounts')
}
if (bad) process.exit(1)
