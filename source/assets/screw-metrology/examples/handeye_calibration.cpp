// T_a_b maps coordinates from frame b to frame a; all translations are millimetres.
#include <opencv2/core.hpp>
#if CV_VERSION_MAJOR >= 5
#include <opencv2/calib.hpp>
#include <opencv2/geometry.hpp>
#else
#include <opencv2/calib3d.hpp>
#endif
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Transform = cv::Matx44d;
cv::Mat rotation(const Transform& T) {
    return cv::Mat(T)(cv::Rect(0, 0, 3, 3)).clone();
}
cv::Mat translation(const Transform& T) {
    return cv::Mat(T)(cv::Rect(3, 0, 1, 3)).clone();
}
Transform pose(cv::Vec3d rvec, cv::Vec3d tvec) {
    cv::Mat R;
    cv::Rodrigues(rvec, R);
    Transform T = Transform::eye();
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) T(r, c) = R.at<double>(r, c);
        T(r, 3) = tvec[r];
    }
    return T;
}
Transform inverse(const Transform& T) {
    Transform result = Transform::eye();
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            result(r, c) = T(c, r);
            result(r, 3) -= T(c, r)*T(c, 3);
        }
    }
    return result;
}
bool diverseMotions(const std::vector<Transform>& poses) {
    if (poses.size() < 3) return false;
    std::vector<cv::Vec3d> axes;
    for (std::size_t i = 1; i < poses.size(); ++i) {
        cv::Vec3d axis;
        cv::Rodrigues(rotation(inverse(poses[i])*poses[0]), axis);
        const double angle = cv::norm(axis);
        if (angle > 1e-3) axes.push_back(axis / angle);
    }
    for (std::size_t i = 0; i < axes.size(); ++i)
        for (std::size_t j = i + 1; j < axes.size(); ++j)
            if (cv::norm(axes[i].cross(axes[j])) > 0.1) return true;
    return false;
}
int main(int argc, char** argv) {
    try {
        const bool degenerate = argc == 2 && std::string(argv[1]) == "--degenerate";
        if (argc > 2 || (argc == 2 && !degenerate))
            throw std::runtime_error("usage: handeye_calibration [--degenerate]");
        const Transform truthX = pose({0.2, -0.1, 0.15}, {30, -20, 80}); // T_g_c
        const Transform Y = pose({0.1, 0.2, -0.1}, {400, 100, 600});     // T_b_t
        std::vector<Transform> G, C;
        std::vector<cv::Mat> Rg, tg, Rc, tc;
        for (int i = 0; i < 12; ++i) {
            const cv::Vec3d r = degenerate ? cv::Vec3d(0, 0, i*0.08) :
                cv::Vec3d(0.5*std::sin(i*0.7), 0.45*std::cos(i*0.6), i*0.08);
            G.push_back(pose(r, {100 + 20.0*i, 50*std::sin(i*0.8), 200}));
            C.push_back(inverse(truthX)*inverse(G.back())*Y);
            Rg.push_back(rotation(G.back())); tg.push_back(translation(G.back()));
            Rc.push_back(rotation(C.back())); tc.push_back(translation(C.back()));
        }
        // A minimal capture precheck, not a complete uncertainty/conditioning analysis.
        if (!diverseMotions(G))
            throw std::runtime_error("rejected: insufficient nonparallel rotation axes");
        cv::Mat Rx, tx;
        cv::calibrateHandEye(Rg, tg, Rc, tc, Rx, tx, cv::CALIB_HAND_EYE_PARK);
        if (!cv::checkRange(Rx) || !cv::checkRange(tx))
            throw std::runtime_error("nonfinite hand-eye result");
        Transform X = Transform::eye();
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) X(r, c) = Rx.at<double>(r, c);
            X(r, 3) = tx.at<double>(r);
        }
        const double rotationError = cv::norm(Rx, rotation(truthX), cv::NORM_L2);
        const double translationError = cv::norm(tx, translation(truthX), cv::NORM_L2);
        double maxClosureR = 0, maxClosureT = 0, maxAxXb = 0;
        for (std::size_t i = 0; i < G.size(); ++i) {
            const Transform closure = G[i]*X*C[i];
            maxClosureR = std::max(maxClosureR, cv::norm(rotation(closure), rotation(Y)));
            maxClosureT = std::max(maxClosureT, cv::norm(translation(closure), translation(Y)));
            if (i) {
                const Transform A = inverse(G[i])*G[0], B = C[i]*inverse(C[0]);
                maxAxXb = std::max(maxAxXb, cv::norm(cv::Mat(A*X), cv::Mat(X*B)));
            }
        }
        if (rotationError > 1e-7 || translationError > 1e-7
            || maxClosureR > 1e-7 || maxClosureT > 1e-7 || maxAxXb > 1e-7)
            throw std::runtime_error("synthetic transform recovery failed");
        std::cout << "OpenCV " << CV_VERSION << "\nR_g_c=\n" << Rx
                  << "\nt_g_c=\n" << tx << "\nrotation matrix error=" << rotationError
                  << "\ntranslation error=" << translationError << " mm"
                  << "\nmax closure rotation error=" << maxClosureR
                  << "\nmax closure translation error=" << maxClosureT << " mm"
                  << "\nmax AX-XB matrix residual=" << maxAxXb << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
