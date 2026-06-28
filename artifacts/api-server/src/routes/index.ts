import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import authRouter from "./auth";
import firmRouter from "./firm";
import mattersRouter from "./matters";
import firmCompareRouter from "./firm-compare";
import firmClausesRouter from "./firm-clauses";
import firmExportsRouter from "./exports";
import firmAlertsRouter from "./firm-alerts";
import firmSettlementsRouter from "./firm-settlements";
import firmAskRouter from "./firm-ask";
import dashboardRouter from "./dashboard";
import peerSetsRouter from "./peer-sets";
import publicRouter from "./public";
import askRouter from "./ask";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(authRouter);
router.use(firmRouter);
router.use(mattersRouter);
router.use(firmCompareRouter);
router.use(firmClausesRouter);
router.use(firmExportsRouter);
router.use(firmAlertsRouter);
router.use(firmSettlementsRouter);
router.use(firmAskRouter);
router.use(dashboardRouter);
router.use(peerSetsRouter);
router.use(publicRouter);
router.use(askRouter);

export default router;
