window.GrowthCharts = (() => {
  let current;
  let selected = 0;
  let observedWidth = 0;
  let observer;
  const number = (value) => Number(value || 0).toLocaleString("zh-TW");
  const percent = (value) => value == null ? "無作答資料" : `${value}%`;

  function render(data, preserveSelection = false) {
    current = data;
    const target = document.getElementById("trendList");
    if (!observer && window.ResizeObserver) {
      observer = new ResizeObserver(() => {
        if (Math.abs(target.clientWidth - observedWidth) > 1 && current) render(current, true);
      });
      observer.observe(target);
    }
    observedWidth = target.clientWidth;
    if (!data?.points.length) {
      target.innerHTML = `<div class="empty">還沒有學習紀錄。完成練習後，就能看見累積答對的單字與作答表現。
        <a class="growth-start" href="/practice.html">開始練習</a></div>`;
      return;
    }
    // The extra boundary point shows the balance before the first displayed day.
    const points = [{ cumulativeWords: data.baselineWords, rollingAccuracy: null, baseline: true }, ...data.points];
    selected = preserveSelection ? Math.min(selected, points.length - 1) : points.length - 1;
    const width = Math.max(240, observedWidth);
    const height = 240;
    const left = 48;
    const right = width - 30;
    const top = 32;
    const bottom = 202;
    const x = (i) => left + i / (points.length - 1) * (right - left);
    const max = Math.max(4, Math.ceil(data.totalWords / 4) * 4);
    const y = (value, ceiling) => bottom - value / ceiling * (bottom - top);
    function chart(key, ceiling, area) {
      let drawing = false;
      let path = "";
      const isolated = [];
      points.forEach((point, i) => {
        if (point[key] == null) { drawing = false; return; }
        path += `${drawing ? "L" : "M"}${x(i)},${y(point[key], ceiling)} `;
        drawing = true;
        if (points[i - 1]?.[key] == null && points[i + 1]?.[key] == null) {
          isolated.push(`<circle cx="${x(i)}" cy="${y(point[key], ceiling)}" r="3" class="growth-line-dot"/>`);
        }
      });
      const ticks = Array.from({ length: 5 }, (_, i) => {
        const value = ceiling * i / 4;
        return `<line x1="${left}" x2="${right}" y1="${y(value, ceiling)}" y2="${y(value, ceiling)}" class="growth-grid"/>
          <text x="${left - 9}" y="${y(value, ceiling) + 4}" text-anchor="end">${number(value)}${area ? "" : "%"}</text>`;
      }).join("");
      const endpoint = (i, label, anchor) => `<circle cx="${x(i)}" cy="${y(points[i][key], ceiling)}" r="4" class="growth-line-dot"/>
        <text class="growth-endpoint" x="${x(i)}" y="${y(points[i][key], ceiling) - 12}" text-anchor="${anchor}">${label}</text>`;
      return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true" data-chart="${key}">
        ${ticks}
        ${area ? `<path d="${path}L${right},${bottom} L${left},${bottom} Z" class="growth-area"/>` : ""}
        <path d="${path}" class="growth-line"/>${isolated.join("")}
        ${area ? endpoint(0, number(data.baselineWords), "start") + endpoint(points.length - 1, number(data.totalWords), "end") : ""}
        <line class="growth-cursor" y1="${top}" y2="${bottom}"/>
        <circle class="growth-selected-dot" r="5"/>
        <text x="${left}" y="228" text-anchor="start">期初</text>
        <text x="${right}" y="228" text-anchor="end">${data.endDate.slice(5).replace("-", "/")}</text>
        ${width >= 480 ? `<text x="${x(Math.floor(points.length / 2))}" y="228" text-anchor="middle">${points[Math.floor(points.length / 2)].studyDate.slice(5).replace("-", "/")}</text>` : ""}
      </svg>`;
    }
    target.innerHTML = `
      <div class="growth-headline">
        <div><span class="muted">累積答對單字</span><div class="growth-total">${number(data.totalWords)} <span>字</span></div></div>
        <div class="growth-gain">本期間新增 <strong>${number(data.newWords)}</strong> 字</div>
      </div>
      <p class="muted small-text">${data.startDate} 至 ${data.endDate} · 期初 ${number(data.baselineWords)} 字<br>同一單字只計一次；代表曾經答對，不代表已精熟。</p>
      <figure class="growth-figure" aria-label="累積答對單字成長圖">
        ${chart("cumulativeWords", max, true)}
      </figure>
      <figure class="growth-figure growth-accuracy" aria-labelledby="accuracyTitle">
        <figcaption id="accuracyTitle">近 7 日作答正確率</figcaption>
        <p class="muted small-text">依當日及前 6 日的總答對數／總作答數計算；題目與難度會影響表現。</p>
        ${chart("rollingAccuracy", 100, false)}
        ${points.every((p) => p.rollingAccuracy == null) ? '<p class="muted small-text">這段期間沒有可計算的作答資料。</p>' : ""}
      </figure>
      <div class="growth-inspector">
        <label for="growthDay">查看日期 <strong id="growthDate"></strong></label>
        <input id="growthDay" type="range" min="0" max="${points.length - 1}" step="1" value="${selected}" aria-describedby="growthHelp"/>
        <p id="growthHelp" class="muted small-text">拖曳圖表或滑桿查看；鍵盤可用方向鍵、Home 與 End。</p>
        <div id="growthDetail" aria-live="polite" aria-atomic="true"></div>
      </div>`;
    const slider = target.querySelector("#growthDay");
    function select(index) {
      selected = Math.max(0, Math.min(points.length - 1, index));
      const point = points[selected];
      const date = point.baseline ? `${data.startDate} 期初（當日作答前）` : point.studyDate;
      slider.value = selected;
      slider.setAttribute("aria-valuetext", `${date}，累積 ${number(point.cumulativeWords)} 字${point.baseline ? "" : `，新增 ${number(point.newWords)} 字，近 7 日正確率 ${percent(point.rollingAccuracy)}`}`);
      target.querySelector("#growthDate").textContent = date;
      target.querySelector("#growthDetail").innerHTML = `<dl class="growth-detail-grid">
        <div><dt>累積答對單字</dt><dd>${number(point.cumulativeWords)} 字</dd></div>
        <div><dt>當日新增</dt><dd>${point.baseline ? "—" : `${number(point.newWords)} 字`}</dd></div>
        <div><dt>當日作答／答對</dt><dd>${point.baseline ? "—" : `${number(point.attempts)}／${number(point.correctCount)} 題`}</dd></div>
        <div><dt>當日正確率</dt><dd>${point.baseline ? "—" : percent(point.accuracy)}</dd></div>
        <div><dt>近 7 日正確率</dt><dd>${point.baseline ? "—" : percent(point.rollingAccuracy)}</dd></div>
      </dl>`;
      target.querySelectorAll("svg[data-chart]").forEach((svg) => {
        const key = svg.dataset.chart;
        const cursor = svg.querySelector(".growth-cursor");
        cursor.setAttribute("x1", x(selected));
        cursor.setAttribute("x2", x(selected));
        const dot = svg.querySelector(".growth-selected-dot");
        dot.style.display = point[key] == null ? "none" : "";
        dot.setAttribute("cx", x(selected));
        dot.setAttribute("cy", y(point[key] || 0, key === "cumulativeWords" ? max : 100));
      });
    }
    slider.addEventListener("input", () => select(Number(slider.value)));
    target.querySelectorAll("svg[data-chart]").forEach((svg) => {
      const inspect = (event) => {
        const box = svg.getBoundingClientRect();
        const position = (event.clientX - box.left) / box.width * width;
        select(Math.round((position - left) / (right - left) * (points.length - 1)));
      };
      svg.addEventListener("pointerdown", (event) => { svg.setPointerCapture(event.pointerId); inspect(event); });
      svg.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse" || svg.hasPointerCapture(event.pointerId)) inspect(event);
      });
    });
    select(selected);
  }
  return { render };
})();
