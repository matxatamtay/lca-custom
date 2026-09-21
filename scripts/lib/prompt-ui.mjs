export async function promptLine(rl, label, current = "") {
  const suffix = current ? ` [${current}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

export async function promptYesNo(rl, label, current = false) {
  const suffix = current ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return Boolean(current);
  return ["y", "yes", "1", "true"].includes(answer);
}

export async function promptSecretUpdate(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : " [optional]";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

export async function promptSecretRequired(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

export async function promptChoice(rl, label, choices, currentId = "") {
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.id === currentId));
  console.log(label);
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? " default" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });
  while (true) {
    const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
    if (!answer) return choices[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    const byId = choices.find((choice) => choice.id.toLowerCase() === answer.toLowerCase());
    if (byId) return byId;
    console.log("Please enter one of the listed numbers.");
  }
}
