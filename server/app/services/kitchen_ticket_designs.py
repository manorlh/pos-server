"""
"עיצוב בון" — a company's named kitchen ticket designs, and the `ticketStyle` each printer prints in
(P:/specs/kitchen-ticket-designs.md §3, §6ג, §8). The look itself: app/services/kitchen_ticket_style.py.

* **Who edits a design**: super admin, distributor, and a company manager whose scope covers the
  design's company — like the kitchen stations. Whoever manages a shop's printers reads the designs
  that shop may use (the printer dialog's picker) and assigns them to its printers.
* **Which designs a shop may use**: its company's and those of the companies above it.
* **A design in use is not deleted** — by a printer, or by a till parameter value naming it
  (`409 design_in_use`, with where). Renamed or changed, every till of the shops it reaches is told.
* **Which design a printer prints in** (`style_for_printer`): its own named design, else its own
  template, else the till parameter `kitchenTicketDesign` (a template or a design's id) as it resolves
  for the printing till, else `classic`. A design the shop may not use, or one gone, counts as unset.
  Then `kitchen_ticket_style.resolve_with_params` with the parameters SET on the till's levels, the
  ink saver as it resolves, and the printer's own options.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.printers import KitchenPrinter, KitchenTicketDesign
from app.models.shop import Shop
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.services import kitchen_ticket_style as S
from app.services.company_hierarchy import ancestor_company_ids, descendant_company_ids, user_covers_company

DESIGN_NAME_MAX = 60
EDIT_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER})

NotifyTarget = Tuple[str, str]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


# ── Who ──────────────────────────────────────────────────────────────────────


def can_edit_company(db: Session, user: User, company: Company) -> bool:
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    return user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, company.id)


def check_edit_company(db: Session, user: User, company: Company) -> None:
    if not can_edit_company(db, user, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def get_company(db: Session, tenant_id: Any, company_id: Any) -> Company:
    ident = _uuid(company_id)
    company = db.query(Company).filter(Company.id == ident).first() if ident else None
    if company is None or (tenant_id is not None and str(company.tenant_id) != str(tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="company_not_found")
    return company


def get_design(db: Session, tenant_id: Any, design_id: Any) -> KitchenTicketDesign:
    ident = _uuid(design_id)
    design = db.query(KitchenTicketDesign).filter(KitchenTicketDesign.id == ident).first() if ident else None
    if design is None or (tenant_id is not None and str(design.tenant_id) != str(tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="design_not_found")
    return design


# ── Which designs a shop may use ─────────────────────────────────────────────


def usable_company_ids(db: Session, company_id: Any) -> List[uuid.UUID]:
    """A company and the companies above it, nearest first (a shop uses their designs)."""
    ident = _uuid(company_id)
    if ident is None:
        return []
    return [ident] + ancestor_company_ids(db, ident)


def designs_for_companies(db: Session, company_ids: Sequence[uuid.UUID]) -> List[KitchenTicketDesign]:
    if not company_ids:
        return []
    rank = {cid: i for i, cid in enumerate(company_ids)}
    rows = db.query(KitchenTicketDesign).filter(KitchenTicketDesign.company_id.in_(list(company_ids))).all()
    return sorted(rows, key=lambda d: (rank.get(d.company_id, 99), d.name))


def designs_for_shop(db: Session, shop: Shop) -> List[KitchenTicketDesign]:
    return designs_for_companies(db, usable_company_ids(db, shop.company_id))


def shop_may_use(db: Session, shop_company_id: Any, design: KitchenTicketDesign) -> bool:
    return design.company_id in usable_company_ids(db, shop_company_id)


# ── Out ──────────────────────────────────────────────────────────────────────


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.isoformat()


def stored_overrides(design: KitchenTicketDesign) -> Dict[str, Any]:
    """The design's overrides as the look takes them today (a part it no longer knows is dropped)."""
    try:
        return S.clean_overrides(design.overrides or {})
    except S.StyleError:
        cleaned: Dict[str, Any] = {}
        for key, value in (design.overrides or {}).items():
            try:
                cleaned.update(S.clean_overrides({key: value}))
            except S.StyleError:
                continue
        return cleaned


def design_style(design: KitchenTicketDesign, ink_saver: bool = True) -> Dict[str, Any]:
    """The design's look with nothing else set (its card's preview)."""
    return S.resolve_style(
        design.template, overrides=stored_overrides(design), design_id=str(design.id), design_name=design.name,
        ink_saver=ink_saver,
    )


def design_out(design: KitchenTicketDesign, company_name: Optional[str] = None,
               usage: Optional[Dict[str, Any]] = None, can_edit: Optional[bool] = None) -> Dict[str, Any]:
    out = {
        "id": str(design.id),
        "companyId": str(design.company_id),
        "companyName": company_name,
        "name": design.name,
        "template": design.template,
        "overrides": stored_overrides(design),
        "style": design_style(design),
        "updatedAt": _iso(design.updated_at),
    }
    if usage is not None:
        out["usage"] = usage
    if can_edit is not None:
        out["canEdit"] = can_edit
    return out


def usage_of(db: Session, design: KitchenTicketDesign) -> Dict[str, Any]:
    """Where it is used: printers (with their shop) and till parameter values naming it."""
    printers = (
        db.query(KitchenPrinter, Shop.name)
        .join(Shop, Shop.id == KitchenPrinter.shop_id)
        .filter(KitchenPrinter.ticket_design_id == design.id)
        .order_by(Shop.name, KitchenPrinter.name)
        .all()
    )
    parameter = db.query(TillParameter).filter(TillParameter.key == S.DESIGN_KEY).first()
    values = []
    if parameter is not None:
        values = [
            {"scopeType": row.scope_type, "scopeId": str(row.scope_id)}
            for row in db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
            if str(row.value).strip().lower() == str(design.id)
        ]
    return {
        "printers": [
            {"id": str(p.id), "name": p.name, "shopId": str(p.shop_id), "shopName": shop_name}
            for p, shop_name in printers
        ],
        "parameterValues": values,
    }


def list_out(db: Session, user: User, tenant_id: Any, company: Company) -> Dict[str, Any]:
    """A company's designs (and those above it it may use), with where each is used."""
    ids = usable_company_ids(db, company.id)
    names = {c.id: c.name for c in db.query(Company).filter(Company.id.in_(ids)).all()} if ids else {}
    return {
        "companyId": str(company.id),
        "canEdit": can_edit_company(db, user, company),
        "designs": [
            design_out(
                d, names.get(d.company_id), usage_of(db, d),
                can_edit=can_edit_company(db, user, db.get(Company, d.company_id)) if d.company_id != company.id
                else can_edit_company(db, user, company),
            )
            for d in designs_for_companies(db, ids)
        ],
        "catalog": S.catalog(),
    }


# ── Writes ───────────────────────────────────────────────────────────────────


def _clean_name(value: Any) -> str:
    name = (value or "").strip() if isinstance(value, str) else ""
    if not name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="design_name_required")
    if len(name) > DESIGN_NAME_MAX:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="design_name_too_long")
    return name


def _clean_template(value: Any) -> str:
    if value not in S.TEMPLATES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="design_template_unknown")
    return value


def clean_overrides_or_422(value: Any) -> Dict[str, Any]:
    try:
        return S.clean_overrides(value)
    except S.StyleError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"design_overrides: {exc}") from exc


def _name_taken(db: Session, company_id: uuid.UUID, name: str, other_than: Optional[uuid.UUID] = None) -> bool:
    query = db.query(KitchenTicketDesign.id).filter(
        KitchenTicketDesign.company_id == company_id, KitchenTicketDesign.name == name
    )
    if other_than is not None:
        query = query.filter(KitchenTicketDesign.id != other_than)
    return query.first() is not None


def create_design(db: Session, user: User, company: Company, name: Any, template: Any, overrides: Any) -> KitchenTicketDesign:
    check_edit_company(db, user, company)
    clean = _clean_name(name)
    if _name_taken(db, company.id, clean):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="design_name_taken")
    design = KitchenTicketDesign(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        name=clean,
        template=_clean_template(template),
        overrides=clean_overrides_or_422(overrides),
        updated_by_user_id=user.id,
    )
    db.add(design)
    db.flush()
    return design


def update_design(db: Session, user: User, design: KitchenTicketDesign, fields: Dict[str, Any]) -> KitchenTicketDesign:
    """`fields`: any of name / template / overrides (overrides replace the design's whole)."""
    company = db.get(Company, design.company_id)
    check_edit_company(db, user, company)
    if "name" in fields:
        clean = _clean_name(fields["name"])
        if _name_taken(db, design.company_id, clean, other_than=design.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="design_name_taken")
        design.name = clean
    if "template" in fields:
        design.template = _clean_template(fields["template"])
    if "overrides" in fields:
        design.overrides = clean_overrides_or_422(fields["overrides"])
    design.updated_at = _now()
    design.updated_by_user_id = user.id
    db.flush()
    return design


def delete_design(db: Session, user: User, design: KitchenTicketDesign) -> None:
    company = db.get(Company, design.company_id)
    check_edit_company(db, user, company)
    usage = usage_of(db, design)
    if usage["printers"] or usage["parameterValues"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "design_in_use", "usage": usage})
    db.delete(design)
    db.flush()


def targets_of(db: Session, design: KitchenTicketDesign) -> List[NotifyTarget]:
    """The active tills of every shop that may use the design (its company and those below)."""
    company_ids = descendant_company_ids(db, design.company_id)
    if not company_ids:
        return []
    shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id.in_(company_ids)).all()]
    if not shop_ids:
        return []
    machines = db.query(POSMachine).filter(POSMachine.shop_id.in_(shop_ids), POSMachine.is_active.is_(True)).all()
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id]


# ── A printer's ticketStyle, for one till ─────────────────────────────────────


class TillTicketSettings:
    """
    The "עיצוב בון" till parameters for one till: the level options SET on its levels, the ink saver
    and the design as they resolve. Three small queries, once per printers pull.
    """

    def __init__(self, db: Session, machine: POSMachine):
        from app.services import till_parameters as TP

        self.db = db
        self.machine = machine
        self.company_id = None
        chain = TP.scope_chain_for_machine(db, machine)
        self.company_id = chain.company_id
        parameters = db.query(TillParameter).filter(TillParameter.key.in_(S.PARAMETER_KEYS)).all()
        on_chain = [
            and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
            for kind, ident in chain.scopes()
        ]
        values = (
            db.query(TillParameterValue)
            .filter(TillParameterValue.parameter_id.in_([p.id for p in parameters]), or_(*on_chain))
            .all()
            if parameters and on_chain
            else []
        )
        resolved = TP.resolve_till_parameters(parameters, values, chain).parameters
        self.params: Dict[str, Any] = {
            p.key: resolved[p.key]
            for p in parameters
            if p.key in S.LEVEL_OPTION_KEYS and p.key in resolved and TP._set_on_chain(p, values, chain)
        }
        ink = resolved.get(S.INK_SAVER_KEY)
        self.params[S.INK_SAVER_KEY] = True if ink is None else bool(ink)
        self.design_value = resolved.get(S.DESIGN_KEY) or S.DEFAULT_TEMPLATE
        self._designs: Dict[uuid.UUID, Optional[KitchenTicketDesign]] = {}
        self._usable: Optional[List[uuid.UUID]] = None

    def _design(self, design_id: Any) -> Optional[KitchenTicketDesign]:
        ident = _uuid(design_id)
        if ident is None:
            return None
        if ident not in self._designs:
            design = self.db.query(KitchenTicketDesign).filter(KitchenTicketDesign.id == ident).first()
            if self._usable is None:
                self._usable = usable_company_ids(self.db, self.company_id)
            if design is not None and (
                design.company_id not in self._usable or str(design.tenant_id) != str(self.machine.tenant_id)
            ):
                design = None
            self._designs[ident] = design
        return self._designs[ident]

    def pick(self, printer: Optional[KitchenPrinter]) -> Tuple[str, Optional[KitchenTicketDesign]]:
        """(template, design or None) the printer prints in on this till."""
        if printer is not None and printer.ticket_design_id is not None:
            design = self._design(printer.ticket_design_id)
            if design is not None:
                return design.template, design
        if printer is not None and printer.ticket_design in S.TEMPLATES:
            return printer.ticket_design, None
        try:
            kind, value = S.parse_design_value(self.design_value)
        except S.StyleError:
            return S.DEFAULT_TEMPLATE, None
        if kind == "template":
            return value, None
        design = self._design(value)
        return (design.template, design) if design is not None else (S.DEFAULT_TEMPLATE, None)

    def style(self, printer: Optional[KitchenPrinter], *, design: Optional[KitchenTicketDesign] = None,
              template: Optional[str] = None, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        The printer's `ticketStyle` here. `design` / `template` + `overrides`: a design picked in the
        dashboard for a test print, in place of the printer's own.
        """
        if design is None and template is None:
            template, design = self.pick(printer)
        if design is not None:
            template = design.template
            overrides = stored_overrides(design)
        style = S.resolve_with_params(
            template or S.DEFAULT_TEMPLATE,
            params=self.params,
            overrides=overrides,
            design_id=str(design.id) if design is not None else None,
            design_name=design.name if design is not None else None,
            printer=printer_options(printer),
        )
        name_order_list(self.db, style)
        return style


def order_list_names(db: Session, entries: Iterable[Dict[str, Any]]) -> Dict[Tuple[str, str], str]:
    """(kind, id) → the course's / category's name, for `order.list` (the till matches by id; the name
    is for its headings and for a course it knows only by name on the ticket)."""
    from app.models.category import Category
    from app.models.menu import MenuCourse

    wanted = {(e["kind"], e["id"]) for e in entries}
    ids = {kind: [_uuid(i) for k, i in wanted if k == kind and _uuid(i) is not None] for kind in ("course", "category")}
    out: Dict[Tuple[str, str], str] = {}
    if ids["course"]:
        for row in db.query(MenuCourse.id, MenuCourse.name).filter(MenuCourse.id.in_(ids["course"])).all():
            out[("course", str(row[0]))] = row[1]
    if ids["category"]:
        for row in db.query(Category.id, Category.name).filter(Category.id.in_(ids["category"])).all():
            out[("category", str(row[0]))] = row[1]
    return out


def name_order_list(db: Session, style: Dict[str, Any]) -> Dict[str, Any]:
    """`style`'s `order.list` with each entry's name, in place."""
    entries = style.get("order", {}).get("list") or []
    if entries:
        names = order_list_names(db, entries)
        for entry in entries:
            entry["name"] = names.get((entry["kind"], entry["id"]))
    return style


def printer_options(printer: Optional[KitchenPrinter]) -> Dict[str, Any]:
    """The printer's own options as the look takes them (a stored value it no longer takes is dropped)."""
    if printer is None:
        return {}
    out: Dict[str, Any] = {}
    if printer.ticket_font_scale is not None and S.FONT_SCALE_MIN <= printer.ticket_font_scale <= S.FONT_SCALE_MAX:
        out["fontScale"] = printer.ticket_font_scale
    if printer.ticket_header is not None:
        try:
            out["header"] = S.printer_header(printer.ticket_header)
        except S.StyleError:
            pass
    if printer.ticket_checkboxes is not None:
        out["checkboxes"] = bool(printer.ticket_checkboxes)
    if printer.ticket_elapsed is not None:
        out["elapsed"] = bool(printer.ticket_elapsed)
    for name, attr in (
        ("fit", "ticket_fit"), ("minTextSize", "ticket_min_text_size"), ("maxTextSize", "ticket_max_text_size"),
        ("headerSize", "ticket_header_size"),
    ):
        if getattr(printer, attr, None) is not None:
            out[name] = getattr(printer, attr)
    if getattr(printer, "ticket_inline_mods", None) is not None:
        out["inlineMods"] = bool(printer.ticket_inline_mods)
    for name, attr in (("order", "ticket_order"), ("groupHeaders", "ticket_group_headers"), ("noCourse", "ticket_no_course")):
        if getattr(printer, attr, None) is not None:
            out[name] = getattr(printer, attr)
    if getattr(printer, "ticket_order_list", None) is not None:
        try:
            out["orderList"] = S.clean_order_list(printer.ticket_order_list)
        except S.StyleError:
            pass
    return out


def printer_ticket_fields(printer: KitchenPrinter) -> Dict[str, Any]:
    """The printer's own "עיצוב בון" settings as the dashboard and the till read them (null = inherit)."""
    return {
        "ticketDesign": printer.ticket_design,
        "ticketDesignId": str(printer.ticket_design_id) if printer.ticket_design_id else None,
        "ticketFontScale": printer.ticket_font_scale,
        "ticketHeader": list(printer.ticket_header) if isinstance(printer.ticket_header, list) else None,
        "ticketCheckboxes": printer.ticket_checkboxes,
        "ticketElapsed": printer.ticket_elapsed,
        "ticketFit": printer.ticket_fit,
        "ticketMinTextSize": printer.ticket_min_text_size,
        "ticketMaxTextSize": printer.ticket_max_text_size,
        "ticketHeaderSize": printer.ticket_header_size,
        "ticketInlineMods": printer.ticket_inline_mods,
        "ticketOrder": printer.ticket_order,
        "ticketOrderList": list(printer.ticket_order_list) if isinstance(printer.ticket_order_list, list) else None,
        "ticketGroupHeaders": printer.ticket_group_headers,
        "ticketNoCourse": printer.ticket_no_course,
    }


def check_printer_design(db: Session, shop: Shop, design_id: Optional[uuid.UUID]) -> None:
    """A printer may name a design its shop may use, nothing else (422)."""
    if design_id is None:
        return
    design = db.query(KitchenTicketDesign).filter(KitchenTicketDesign.id == design_id).first()
    if design is None or str(design.tenant_id) != str(shop.tenant_id) or not shop_may_use(db, shop.company_id, design):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="design_not_usable")


def check_parameter_design(db: Session, shop: Shop, value: Any) -> None:
    """`kitchenTicketDesign` set from a shop's printers page: a template, or a design the shop may use."""
    if value is None:
        return
    try:
        kind, text = S.parse_design_value(value)
    except S.StyleError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid_value:{S.DESIGN_KEY}: {exc}") from exc
    if kind == "design":
        check_printer_design(db, shop, uuid.UUID(text))


def styles_for(db: Session, machine: POSMachine, printers: Iterable[KitchenPrinter]) -> Dict[str, Dict[str, Any]]:
    """printer id → its `ticketStyle` on this till."""
    printers = list(printers)
    if not printers:
        return {}
    settings = TillTicketSettings(db, machine)
    return {str(p.id): settings.style(p) for p in printers}
