// The page talks to this app's server (server.py) through peers.call, under _api/.
const form = document.getElementById("add");
const status = document.getElementById("status");
const rows = document.getElementById("rows");
const totals = document.getElementById("totals");
form.date.valueAsDate = new Date();

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

async function load() {
  try {
    const { expenses, summary } = await peers.call("expenses");
    rows.replaceChildren(...expenses.slice().reverse().map((e) => {
      const tr = document.createElement("tr");
      tr.append(cell(e.date), cell(Number(e.amount).toFixed(2)), cell(e.category), cell(e.note));
      return tr;
    }));
    const months = Object.entries(summary.months).slice(-3).map(([m, v]) => `${m}: ${v.toFixed(2)}`);
    const top = Object.entries(summary.categories).slice(0, 3).map(([c, v]) => `${c} ${v.toFixed(2)}`);
    totals.textContent = expenses.length ? `By month: ${months.join(" · ")}. Top: ${top.join(" · ")}.` : "Nothing logged yet.";
    status.textContent = "";
  } catch (err) {
    status.textContent = err.message;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    await peers.call("expenses", data);
    form.amount.value = "";
    form.note.value = "";
    await load();
  } catch (err) {
    status.textContent = err.message;
  }
});

load();
