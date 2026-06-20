import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import peerSetsRouter from "./peer-sets";
import publicRouter from "./public";
import askRouter from "./ask";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(peerSetsRouter);
router.use(publicRouter);
router.use(askRouter);

export default router;
