"""Audit gate A: upstream smoke tests (real library calls, no mocks)."""
import numpy as np
import pandapipes as pp
from compopt.physics.chip import make_gpu
from compopt.physics.fluids import CoolantLoop
from pandapipes.properties.fluids import _add_fluid_to_net

from loopkeeper.physics.adapters.thermal_compopt import RackThermal


def test_compopt_one_step():
    gpu = make_gpu("H100_SXM", coolant_loop=CoolantLoop(T_in_C=35.0, m_dot_kg_s=0.25))
    t0 = gpu.T_C.copy()
    gpu.step(1.0)
    assert gpu.time_s == 1.0 and np.all(np.isfinite(gpu.T_C)) and not np.allclose(gpu.T_C, t0)


def test_compopt_adapter_accepts_external_flow_and_heat():
    rt = RackThermal("H100_SXM", 180, 0.7, {"tiles": .78, "hbm": .12, "vrm": .07, "pcb": .03}, 6.0, 1.5, 3900.0, 1025.0, 33.0)
    rt.set_heat(114e3)
    for _ in range(40):
        rt.step(0.5, 33.0, 1.5)
    hot = rt.t_chip_c
    for _ in range(40):
        rt.step(0.5, 33.0, 0.75)          # halve the externally supplied flow
    assert rt.t_chip_c > hot + 2.0


def test_pandapipes_one_solve_closed_loop():
    net = pp.create_empty_network("g", add_stdtypes=True)
    _add_fluid_to_net(net, pp.create_constant_fluid("w", "liquid", density=997., viscosity=8e-4, heat_capacity=4180., compressibility=0.0))
    j = [pp.create_junction(net, pn_bar=3.0, tfluid_k=300.) for _ in range(3)]
    pp.create_pump_from_parameters(net, j[0], j[1], "p", poly_coefficents=[0.0, 0.0, 1.0])
    pp.create_pipe_from_parameters(net, j[1], j[2], length_km=0.01, inner_diameter_mm=100, k_mm=0.045, loss_coefficient=20)
    pp.create_pipe_from_parameters(net, j[2], j[0], length_km=0.01, inner_diameter_mm=100, k_mm=0.045)
    pp.create_ext_grid(net, j[0], p_bar=3.0, t_k=300.)
    pp.pipeflow(net, mode="hydraulics", init="flat")
    assert net.converged and net.res_pump.mdot_from_kg_per_s.iloc[0] > 0.5
    assert abs(net.res_ext_grid.mdot_kg_per_s.iloc[0]) < 1e-6      # closed loop: no mass leaves
