from app.models.user import User, UserRole
from app.models.tenant import Tenant, TenantStatus
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.pairing_code import PairingCode
from app.models.pairing_session import PairingSession
from app.models.elevated_session import ElevatedSession
from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.product import Product, CatalogLevel as ProductCatalogLevel
from app.models.sync_log import SyncLog, SyncDirection, SyncEntityType, SyncAction, SyncStatus
from app.models.shop_product_override import ShopProductOverride
from app.models.product_availability_override import (
    AreaProductOverride,
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.availability_reopen import AvailabilityDayClose, AvailabilityReopen
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.shop_category_override import ShopCategoryOverride
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZReport
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop_z_sequence import ShopZSequence
from app.models.machine_z_sequence import MachineZSequence
from app.models.shop_z_remote_part import ShopZRemotePart
from app.models.shop_register_sequence import ShopRegisterSequence
from app.models.org_number_sequence import OrgNumberSequence
from app.models.tenant_sku_sequence import TenantSkuSequence
from app.models.tenant_local_sku_sequence import TenantLocalSkuSequence
from app.models.voucher import Voucher, ValueDisplayMode
from app.models.customer import Customer
from app.models.issued_voucher import IssuedVoucher, IssuedVoucherStatus
from app.models.stock_level import StockLevel
from app.models.z_run import ZRun, ZRunItem, ZRunItemStatus, ZRunStatus
from app.models.shift_close_request import ShiftCloseRequest, ShiftCloseRequestStatus
from app.models.till_z_request import TillZRequest, TillZRequestStatus
from app.models.card_transmission import (
    CardTransmission,
    CardTransmissionItem,
    TransmitRequest,
    TransmitRequestStatus,
)
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.offline_authorization import OfflineAuthorization, OfflineAuthorizationItem
from app.models.app_release import AppRelease, AppReleaseAssignment, AppReleaseMachineStatus
from app.models.accounting import AccountingExportBatch, AccountingExportItem, AccountingSettings
from app.models.till_message import TillMessage, TillMessageReceipt
from app.models.audit_exception import AuditException, ExceptionRuleValue, TillEvent
# "עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md) — informational, never a fiscal total.
from app.models.failed_payment import FailedPaymentAttempt
# "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the dashboard asks a till to issue a credit.
from app.models.remote_credit import RemoteCreditEvent, RemoteCreditRequest
# "זיכוי באשראי מהענן (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds the card.
from app.models.cloud_card_refund import CloudCardRefund, CloudCardRefundEvent
from app.models.document_refusal import DocumentRefusal
# "יומן חריגות" + "התראות SMS על חריגות" (app/services/exception_alerts).
from app.models.exception_alerts import (
    ExceptionAlertDispatch,
    ExceptionAlertRule,
    ExceptionAlertRuleChange,
    ExceptionLogEntry,
)
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherBatchItem,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
    TransactionVoucherDiscount,
)
from app.models.promotion import Promotion, TransactionPromotion
from app.models.tables import DiningTable, TableCancelReason, TableEvent, TableOrder, TableReservation, TableType, TableZone
from app.models.platform_setting import PlatformSetting
from app.models.printers import KitchenPrinter, KitchenPrinterRoute, KitchenPrintJob
from app.models.menu import (
    MealSlot,
    MealSlotOption,
    MenuCourse,
    MenuSyncState,
    ModifierGroup,
    ModifierLink,
    ModifierOption,
    PrepNotePreset,
    TransactionItemPart,
    UpsellRule,
    UpsellStat,
)
from app.models.product_cost import ProductCost
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.training import DemoMenuItem, TrainingAuditLog, TrainingDocument
from app.models.pos_user_session import PosUserSession
# "נוכחות עובדים" (docs/SPEC_ATTENDANCE.md) — separate from PosUserSession on purpose.
from app.models.attendance import AttendanceAdjustment, AttendanceBreak, AttendanceShift, EmployeeRole
from app.models.menu_broadcast import CatalogPublication, ShopWorkTypes
# "תפריטים" (docs/SPEC_MENUS.md) — named sales menus by schedule, not the modifier layer.
from app.models.catalog_menu import (
    CatalogMenu,
    CatalogMenuAssignment,
    CatalogMenuCategory,
    CatalogMenuFallback,
    CatalogMenuProduct,
    CatalogMenuSyncState,
)
from app.models.payment_secret import PaymentIntegrationSecret
# The self-order kiosk (app/services/kiosk_control.py) — not the device lock `kioskMode`.
from app.models.kiosk import (
    KioskCommand,
    KioskDevice,
    KioskOrder,
    KioskPickupAllocation,
    KioskPickupCounter,
    KioskSettings,
)
# The kiosk's alerts to the tills and its close with the shop Z (docs/SPEC_KIOSK.md §16).
from app.models.kiosk_ops import KioskAlert, KioskCloseRequest
# "ביצועי קיוסקים": the kiosk's anonymous funnel (docs/SPEC_KIOSK_INSIGHTS.md).
from app.models.kiosk_insights import KioskEvent, KioskSession
# "סוללה חלשה": a device's low-battery alerts and their history (docs/SPEC_KIOSK_INSIGHTS.md §6).
from app.models.device_battery import DeviceBatteryAlert
# The Android kiosk's web renderer status (kiosk web bundles, platform "kiosk_web").
from app.models.kiosk_web import KioskWebDeviceStatus
# "עיצוב קופה": the till design layers (docs/SPEC_TILL_DESIGN.md).
from app.models.till_design import TillDesignSettings
# "תפקידים והרשאות" for till users (docs/SPEC_ROLES_PERMISSIONS.md).
from app.models.till_role import TillRole, TillRoleChange
from app.models.cash_drawer import CashDrawerEvent, CashMovement
# "שירות הודעות ו-019" + "מועדון לקוחות" (docs/SPEC_NOTIFICATIONS_CLUB.md).
from app.models.outbox import OutboxEvent
from app.models.notifications import (
    Campaign, CampaignRecipient, DeliveryEvent, Notification, NotificationAttempt,
    NotificationProviderConfig, NotificationTemplate,
)
from app.models.club import (
    ClubAuditEvent, ClubBenefitGrant, ClubConsentEvent, ClubCustomer, ClubDocumentVersion,
    ClubLandingPage, ClubMembership, ClubOtpChallenge, ClubPointsLedger, ClubProgram,
    ClubRedemptionReservation, ClubSaleLink, ClubSourceToken, ClubSuppression,
)
# KDS and "תצורת עבודה לעמדה" (docs/SPEC_KDS.md).
from app.models.kds import (
    FulfillmentGroup, KdsDevice, KdsRouteOverride, KdsShopState, KdsStationSetting, KitchenAction,
    KitchenChange, KitchenDispatch, KitchenOrder, KitchenTask,
)
# "הרשאות דשבורד": per dashboard user — sections, org scope, templates, audit.
from app.models.dashboard_access import DashboardAccessAudit, DashboardAccessProfile, DashboardAccessTemplate

__all__ = [
    "User", "UserRole",
    "ElevatedSession",
    "Tenant", "TenantStatus",
    "TenantMembership", "TenantMembershipRole",
    "Company",
    "Shop",
    "ShopArea",
    "POSMachine", "PairingStatus",
    "PairingCode",
    "PairingSession",
    "DevicePairingRequest", "DevicePairingStatus",
    "Category", "CategoryCatalogLevel",
    "Product", "ProductCatalogLevel",
    "SyncLog", "SyncDirection", "SyncEntityType", "SyncAction", "SyncStatus",
    "ShopProductOverride",
    "CompanyProductOverride",
    "AreaProductOverride",
    "MachineProductOverride",
    "MachineCatalogItem",
    "ShopCategoryOverride",
    "CategoryAvailabilityOverride",
    "Shift", "ShiftStatus",
    "Transaction", "TransactionStatus",
    "TransactionItem",
    "TransactionPayment",
    "ZReport",
    "PosUser", "PosUserRole",
    "ShopRegisterSequence",
    "OrgNumberSequence",
    "TenantSkuSequence",
    "TenantLocalSkuSequence",
    "Voucher", "ValueDisplayMode",
    "Customer",
    "IssuedVoucher", "IssuedVoucherStatus",
    "StockLevel",
    "StockMovement", "StockMovementReason",
    "ZRun", "ZRunItem", "ZRunStatus", "ZRunItemStatus",
    "ShiftCloseRequest", "ShiftCloseRequestStatus",
    "TillZRequest", "TillZRequestStatus",
    "MachineZSequence",
    "ShopZRemotePart",
    "CardTransmission", "CardTransmissionItem", "TransmitRequest", "TransmitRequestStatus",
    "TillParameter", "TillParameterValue",
    "OfflineAuthorization", "OfflineAuthorizationItem",
    "AppRelease", "AppReleaseAssignment", "AppReleaseMachineStatus",
    "AccountingSettings", "AccountingExportBatch", "AccountingExportItem",
    "TillMessage", "TillMessageReceipt",
    "AuditException", "ExceptionRuleValue", "TillEvent",
    "FailedPaymentAttempt",
    "PrepaidVoucherBatch", "PrepaidVoucherBatchItem", "PrepaidVoucher", "PrepaidVoucherRedemption",
    "PrepaidVoucherEvent", "PrepaidVoucherReservation", "TransactionVoucherDiscount",
    "Promotion", "TransactionPromotion",
    "TableZone", "DiningTable", "TableOrder", "TableEvent", "TableCancelReason", "TableReservation", "TableType", "PlatformSetting",
    "KitchenPrinter", "KitchenPrinterRoute", "KitchenPrintJob",
    "ModifierGroup", "ModifierOption", "ModifierLink", "PrepNotePreset", "MealSlot", "MealSlotOption",
    "UpsellRule", "UpsellStat", "MenuCourse", "MenuSyncState", "TransactionItemPart",
    "ReportEvent", "ReportEventMachine",
    "TrainingDocument", "TrainingAuditLog", "DemoMenuItem",
    "PosUserSession",
    "EmployeeRole", "AttendanceShift", "AttendanceBreak", "AttendanceAdjustment",
    "CatalogPublication", "ShopWorkTypes",
    "CatalogMenu", "CatalogMenuAssignment", "CatalogMenuCategory", "CatalogMenuFallback",
    "CatalogMenuProduct", "CatalogMenuSyncState",
    "PaymentIntegrationSecret",
    "OutboxEvent",
    "Campaign", "CampaignRecipient", "DeliveryEvent", "Notification", "NotificationAttempt",
    "NotificationProviderConfig", "NotificationTemplate",
    "ClubAuditEvent", "ClubBenefitGrant", "ClubConsentEvent", "ClubCustomer", "ClubDocumentVersion",
    "ClubLandingPage", "ClubMembership", "ClubOtpChallenge", "ClubPointsLedger", "ClubProgram",
    "ClubRedemptionReservation", "ClubSaleLink", "ClubSourceToken", "ClubSuppression",
    "KioskSettings", "KioskDevice", "KioskOrder", "KioskPickupCounter", "KioskPickupAllocation", "KioskCommand",
    "KioskSession", "KioskEvent", "DeviceBatteryAlert", "KioskWebDeviceStatus",
    "RemoteCreditRequest", "RemoteCreditEvent",
    "CloudCardRefund", "CloudCardRefundEvent",
    "DocumentRefusal",
    "ExceptionLogEntry", "ExceptionAlertRule", "ExceptionAlertDispatch", "ExceptionAlertRuleChange",
    "TillDesignSettings",
    "DashboardAccessAudit", "DashboardAccessProfile", "DashboardAccessTemplate",
    "TillRole", "TillRoleChange",
    "CashDrawerEvent", "CashMovement",
]
