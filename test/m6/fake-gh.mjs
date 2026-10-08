// A stand-in for `gh api` (test only): a private repo with one PR, comments kept in a JSON file.
import fs from "node:fs";
const db = process.env.FAKE_GH_DB; const read = () => (fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8")) : { comments: [], next: 1000 });
const args = process.argv.slice(2); if (args[0] !== "api") process.exit(2);
const route = args[1]; const post = args.includes("POST");
if (/^repos\/o\/egg$/.test(route)) { process.stdout.write(JSON.stringify({ id: 4242, private: true })); process.exit(0); }
if (/^repos\/o\/egg\/issues\/5$/.test(route)) { process.stdout.write(JSON.stringify({ number: 5, pull_request: {}, title: "room" })); process.exit(0); }
if (/^repos\/o\/egg\/issues\/5\/comments/.test(route)) {
  const state = read();
  if (post) { const body = JSON.parse(fs.readFileSync(0, "utf8")).body; const c = { id: state.next++, user: { login: "owner", type: "User" }, created_at: new Date().toISOString(), body }; state.comments.push(c); fs.writeFileSync(db, JSON.stringify(state)); process.stdout.write(JSON.stringify(c)); process.exit(0); }
  const page = Number(/[?&]page=(\d+)/.exec(route)?.[1] ?? 1);
  process.stdout.write(JSON.stringify(page === 1 ? state.comments : [])); process.exit(0);
}
process.stderr.write(`fake gh: no route ${route}`); process.exit(1);
