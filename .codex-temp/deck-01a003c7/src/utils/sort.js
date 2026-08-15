const naturalCollator = new Intl.Collator("zh-Hant", {
  numeric: true,
  sensitivity: "base"
});

function naturalCompare(a, b) {
  return naturalCollator.compare(String(a ?? ""), String(b ?? ""));
}

module.exports = {
  naturalCompare
};
