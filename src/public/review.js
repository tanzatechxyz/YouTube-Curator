"use strict";

const bulkReviewForm = document.querySelector("[data-bulk-review]");

if (bulkReviewForm) {
  const selectAll = bulkReviewForm.querySelector("[data-review-select-all]");
  const selectedCount = bulkReviewForm.querySelector(
    "[data-review-selected-count]",
  );
  const items = [
    ...document.querySelectorAll("[data-review-item]"),
  ];

  function updateSelection() {
    const checked = items.filter((item) => item.checked).length;
    if (selectedCount) {
      selectedCount.textContent = String(checked);
    }
    if (selectAll) {
      selectAll.checked = checked > 0 && checked === items.length;
      selectAll.indeterminate = checked > 0 && checked < items.length;
    }
  }

  selectAll?.addEventListener("change", () => {
    for (const item of items) {
      item.checked = selectAll.checked;
    }
    updateSelection();
  });
  for (const item of items) {
    item.addEventListener("change", updateSelection);
  }

  bulkReviewForm.addEventListener("submit", (event) => {
    const operation = event.submitter?.value || "";
    const selected = items.filter((item) => item.checked).length;
    const usesSelection = operation.endsWith("_selected");
    if (usesSelection && selected === 0) {
      event.preventDefault();
      window.alert("Select at least one review item.");
      return;
    }
    const count = usesSelection ? selected : items.length;
    const approving = operation.startsWith("approve");
    const verb = approving ? "approve" : "reject";
    const quotaWarning = approving
      ? " Approving can use YouTube API quota."
      : "";
    if (
      !window.confirm(
        `Are you sure you want to ${verb} ${count} video${count === 1 ? "" : "s"}?${quotaWarning}`,
      )
    ) {
      event.preventDefault();
    }
  });

  updateSelection();
}
