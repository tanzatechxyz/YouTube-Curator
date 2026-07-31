"use strict";

const EMPTY_OPERATORS = new Set(["is_empty", "is_not_empty"]);

function readChoices(option) {
  try {
    const parsed = JSON.parse(option.dataset.choices || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function initialiseRuleBuilder(builder) {
  const field = builder.querySelector("[data-rule-field]");
  const operator = builder.querySelector("[data-rule-operator]");
  const action = builder.querySelector("[data-rule-action]");
  const input = builder.querySelector("[data-rule-value-input]");
  const choice = builder.querySelector("[data-rule-value-select]");
  const help = builder.querySelector("[data-rule-help]");
  const destinations = builder.querySelector("[data-rule-destinations]");
  if (!field || !operator || !action || !input || !choice || !help) {
    return;
  }

  function selectedField() {
    return field.options[field.selectedIndex];
  }

  function updateValueControl() {
    const selected = selectedField();
    const kind = selected.dataset.kind || "text";
    const choices = readChoices(selected);
    const noValue = EMPTY_OPERATORS.has(operator.value);

    input.hidden = noValue || choices.length > 0;
    input.disabled = noValue || choices.length > 0;
    input.required = !input.disabled;
    input.toggleAttribute("name", !input.disabled);
    if (!input.disabled) {
      input.name = "value";
    }

    choice.hidden = noValue || choices.length === 0;
    choice.disabled = noValue || choices.length === 0;
    choice.required = !choice.disabled;
    choice.toggleAttribute("name", !choice.disabled);
    if (!choice.disabled) {
      choice.name = "value";
      const previous = choice.value;
      choice.replaceChildren(
        ...choices.map((item) => {
          const option = document.createElement("option");
          option.value = String(item.value);
          option.textContent = String(item.label);
          return option;
        }),
      );
      if (choices.some((item) => String(item.value) === previous)) {
        choice.value = previous;
      }
    }

    input.type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
    input.step = kind === "number" ? "any" : "";
    input.placeholder = selected.dataset.placeholder || "";
    input.toggleAttribute("min", selected.dataset.min !== "");
    input.toggleAttribute("max", selected.dataset.max !== "");
    if (selected.dataset.min !== "") {
      input.min = selected.dataset.min;
    }
    if (selected.dataset.max !== "") {
      input.max = selected.dataset.max;
    }
    if (selected.value === "channel") {
      input.setAttribute("list", "channel-suggestions");
    } else {
      input.removeAttribute("list");
    }
    help.textContent = noValue
      ? "No comparison value is needed for this operator."
      : selected.dataset.help || "";
  }

  function updateField() {
    const selected = selectedField();
    const allowed = new Set((selected.dataset.operators || "").split(","));
    for (const option of operator.options) {
      const available = allowed.has(option.value);
      option.disabled = !available;
      option.hidden = !available;
    }
    if (!allowed.has(operator.value)) {
      const preferred = ["equals", "contains", "at_least", "before"].find(
        (value) => allowed.has(value),
      );
      operator.value = preferred || [...allowed][0] || "";
    }
    updateValueControl();
  }

  function updateAction() {
    if (destinations) {
      destinations.hidden = action.value === "reject";
    }
  }

  field.addEventListener("change", updateField);
  operator.addEventListener("change", updateValueControl);
  action.addEventListener("change", updateAction);
  updateField();
  updateAction();
}

for (const builder of document.querySelectorAll("[data-rule-builder]")) {
  initialiseRuleBuilder(builder);
}
