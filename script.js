function init() {
  const sectionPanel = document.querySelector("#sectionPanel");
  const sectionList = document.querySelector("#sectionList");
  const sectionHint = document.querySelector("#sectionHint");
  const exhausted = document.querySelector("#exhausted");
  const statusText = document.querySelector("#status");
  const modal = document.querySelector("#copyModal");
  const modalTitle = document.querySelector("#modalTitle");
  const modalText = document.querySelector("#modalText");
  const modalCopy = document.querySelector("#modalCopy");
  const modalClose = document.querySelector("#modalClose");
  const modalPreview = document.querySelector("#modalPreview");
  const postImage = document.querySelector("#postImage");
  const toast = document.querySelector("#toast");

  if (!sectionPanel || !sectionList || !exhausted || !statusText || !modal || !modalText || !modalCopy || !toast) {
    console.error("Missing required UI elements.");
    return;
  }

  let toastTimer;
  let busy = false;
  let activeReservation = null;
  let localCopied = false;
  let copyCommitted = false;
  let commitStarted = false;
  let selectedButton = null;

  function setStatus(message) {
    statusText.textContent = message;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
  }

  function setButtonsDisabled(disabled) {
    sectionList.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled;
    });
  }

  function rememberReservation(data) {
    activeReservation = {
      textId: data.textId,
      reservationToken: data.reservationToken,
    };
    localCopied = false;
    copyCommitted = false;
    commitStarted = false;
  }

  function clearPressed() {
    sectionList.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", "false");
    });
    selectedButton = null;
  }

  async function releaseActive(keepalive = false) {
    if (!activeReservation || copyCommitted || commitStarted) return;
    const payload = activeReservation;
    activeReservation = null;
    try {
      await fetch("/api/claim/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive,
      });
    } catch (error) {
      console.error(error);
    }
  }

  function showExhausted(message) {
    const text = message || "次数已用完";
    sectionPanel.hidden = true;
    sectionHint.hidden = true;
    exhausted.hidden = false;
    exhausted.textContent = text;
    setStatus(text);
    clearPressed();
  }

  function showPicker() {
    exhausted.hidden = true;
    sectionPanel.hidden = false;
    sectionHint.hidden = false;
  }

  function renderSections(sections) {
    showPicker();
    sectionList.replaceChildren();
    sections.forEach((section) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "section-btn";
      button.textContent = section.name;
      button.dataset.sectionId = section.id;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        chooseSection(section, button);
      });
      sectionList.appendChild(button);
    });
    setStatus("请选择一个板块");
  }

  async function loadSections() {
    const response = await fetch("/api/sections");
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.sections) || !data.sections.length) {
      showExhausted(data.message || "次数已用完");
      return false;
    }
    renderSections(data.sections);
    return true;
  }

  function hideModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    modalText.value = "";
    modalPreview.hidden = true;
    postImage.removeAttribute("src");
    clearPressed();
  }

  function openModal(section, data) {
    rememberReservation(data);
    modalTitle.textContent = section.name || data.sectionName || "文案";
    modalText.value = data.text || "";
    if (data.image) {
      modalPreview.hidden = false;
      postImage.src = data.image;
    } else {
      modalPreview.hidden = true;
      postImage.removeAttribute("src");
    }
    modal.hidden = false;
    document.body.classList.add("modal-open");
    setStatus("请在弹窗中复制文案。");
    modalCopy.focus();
  }

  async function chooseSection(section, button) {
    if (busy || !section?.id) return;
    busy = true;
    setButtonsDisabled(true);
    clearPressed();
    button.setAttribute("aria-pressed", "true");
    selectedButton = button;
    setStatus("正在获取文案...");

    const previous = activeReservation;
    try {
      const response = await fetch(`/api/sections/${encodeURIComponent(section.id)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousTextId: previous?.textId || "",
          previousReservationToken: previous?.reservationToken || "",
        }),
      });
      const data = await response.json();
      if (previous) activeReservation = null;

      if (!data.ok) {
        if (data.message === "次数已用完") {
          hideModal();
          showExhausted(data.message);
          return;
        }
        setStatus(data.message || "获取失败，请重试");
        button.setAttribute("aria-pressed", "false");
        return;
      }

      openModal(section, data);
    } catch (error) {
      setStatus("素材加载失败，请稍后重试。");
      button.setAttribute("aria-pressed", "false");
      console.error(error);
    } finally {
      busy = false;
      setButtonsDisabled(false);
      if (selectedButton) selectedButton.disabled = false;
    }
  }

  async function writeClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.error(error);
    }

    try {
      modalText.focus();
      modalText.select();
      return document.execCommand("copy");
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  async function commitCopy() {
    if (copyCommitted || commitStarted || !activeReservation) return false;
    commitStarted = true;
    const payload = activeReservation;
    try {
      const response = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data.ok) {
        commitStarted = false;
        if (String(data.message || "").includes("失效")) {
          activeReservation = null;
          localCopied = false;
          hideModal();
          showToast(data.message);
          await loadSections();
          setStatus(data.message);
          return false;
        }
        setStatus(data.message || "复制已完成，但标记失败，请再点一次复制。");
        showToast("标记失败，请重试");
        return false;
      }

      copyCommitted = true;
      activeReservation = null;
      setStatus("文案已复制，可以直接粘贴到小红书。");
      showToast("复制成功");
      return true;
    } catch (error) {
      commitStarted = false;
      setStatus("复制已完成，但标记失败，请再点一次复制。");
      showToast("网络异常，请重试");
      console.error(error);
      return false;
    }
  }

  async function copyFromModal() {
    if (copyCommitted) {
      showToast("已经复制");
      return;
    }
    if (!localCopied) {
      const copied = await writeClipboard(modalText.value);
      if (!copied) {
        setStatus("自动复制失败，请在文案框中长按或选择后复制。");
        showToast("复制失败，请手动复制");
        return;
      }
      localCopied = true;
    }
    await commitCopy();
  }

  async function closeModal() {
    if (localCopied && !copyCommitted) await commitCopy();
    const copied = copyCommitted;
    if (!copyCommitted) await releaseActive();
    hideModal();
    if (copied) {
      const stillOpen = await loadSections();
      setStatus(stillOpen ? "文案已复制，可以直接粘贴到小红书。" : "文案已复制。次数已用完。");
      return;
    }
    if (!exhausted.hidden) return;
    setStatus("请选择一个板块");
  }

  modalCopy.addEventListener("click", () => {
    copyFromModal();
  });

  modalText.addEventListener("copy", () => {
    localCopied = true;
    commitCopy();
  });

  modalClose.addEventListener("click", () => {
    closeModal();
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeModal();
  });

  window.addEventListener("pagehide", () => {
    if (!activeReservation || copyCommitted || commitStarted) return;
    fetch("/api/claim/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activeReservation),
      keepalive: true,
    }).catch(() => {});
  });

  function loadBackgroundWhenIdle() {
    const load = () => {
      const image = new Image();
      image.onload = () => document.body.classList.add("bg-ready");
      image.src = "./assets/space-bg.jpg";
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(load, { timeout: 1600 });
      return;
    }

    setTimeout(load, 600);
  }

  loadBackgroundWhenIdle();
  loadSections().catch((error) => {
    sectionPanel.hidden = true;
    setStatus("素材加载失败，请稍后重试。");
    console.error(error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
