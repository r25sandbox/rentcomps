/*
============================================================
pricing-modal.js
============================================================
Version : 1.0
Date    : 2026-05-23
Purpose : Inspection Request modal logic. Loaded by Carrd
          Pricing embed (Realty25_Pricing_Carrd_Embed.html
          v1.10+) via <script src> reference. Modal HTML and
          CSS still live inline in the embed - only the JS
          payload is externalized to keep the embed under
          Carrd's parser size threshold (v1.9 at ~12K choked
          with SyntaxError; this split brings embed to ~9K).

Repo    : r25sandbox/rec/pricing-modal.js
Hosting : https://r25sandbox.github.io/rentcomps/pricing-modal.js
Cache   : Bump ?vNN on embed <script src> after each commit.

Pairs with: Realty25_Pricing_Carrd_Embed.html v1.10+

------------------------------------------------------------
Changelog (most recent 5)
------------------------------------------------------------
v1.0  2026-05-23  Initial extraction. Logic identical to v1.9
                  inline IIFE - just relocated. No behavior
                  changes. Submit remains a placeholder
                  success state; backend wiring is the next
                  phase.
============================================================
*/

(function(){
  function gi(id){return document.getElementById(id);}
  var overlay=gi("r25ir-overlay");
  if(!overlay) return; // embed not on page - bail silently
  var closeBtn=gi("r25ir-close");
  var titleEl=gi("r25ir-title");
  var submitBtn=gi("r25ir-submit");
  var msg=gi("r25ir-msg");
  var formBox=gi("r25ir-form");
  var first=gi("r25ir-first");
  var last=gi("r25ir-last");
  var email=gi("r25ir-email");
  var phone=gi("r25ir-phone");
  var currentType="";
  var TYPE_LABELS={"PCI":"Property Condition Inspection","MoveOut":"Move Out Inspection"};

  function showMsg(text,color){
    msg.style.color=color||"#E8C96A";
    msg.textContent=text;
  }
  function clrMsg(){msg.textContent="";}

  function resetForm(){
    first.value="";last.value="";email.value="";phone.value="";
    submitBtn.disabled=false;
    submitBtn.textContent="Submit Request";
    formBox.style.display="block";
    clrMsg();
  }

  function openModal(type){
    currentType=type;
    var label=TYPE_LABELS[type]||"Inspection";
    titleEl.textContent="Request "+label;
    resetForm();
    overlay.classList.add("r25ir-open");
    document.body.style.overflow="hidden";
    setTimeout(function(){first.focus();},50);
  }

  function closeModal(){
    overlay.classList.remove("r25ir-open");
    document.body.style.overflow="";
  }

  function validEmail(e){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}

  function doSubmit(){
    clrMsg();
    var f=first.value.trim();
    var l=last.value.trim();
    var e=email.value.trim();
    if(!f){showMsg("Please enter your first name.","#f87171");return;}
    if(!l){showMsg("Please enter your last name.","#f87171");return;}
    if(!e||!validEmail(e)){showMsg("Please enter a valid email.","#f87171");return;}
    // Placeholder success - backend wiring is next phase.
    // currentType holds "PCI" or "MoveOut" - ready for /inspection-request POST.
    submitBtn.disabled=true;
    submitBtn.textContent="Sent";
    showMsg("Thanks - request received. I will be in touch shortly.","#86efac");
  }

  // Wire Request pill buttons
  var pills=document.querySelectorAll("#r25-pricing a.req-pill[data-r25ir-type]");
  for(var i=0;i<pills.length;i++){
    pills[i].addEventListener("click",function(ev){
      ev.preventDefault();
      var t=this.getAttribute("data-r25ir-type");
      openModal(t);
    });
  }

  closeBtn.addEventListener("click",closeModal);
  submitBtn.addEventListener("click",doSubmit);
  overlay.addEventListener("click",function(e){if(e.target===overlay){closeModal();}});
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&overlay.classList.contains("r25ir-open")){closeModal();}
  });
})();
